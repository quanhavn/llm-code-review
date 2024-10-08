import { readFileSync } from "fs";
import * as core from "@actions/core";
import OpenAI from "openai";
import { Octokit } from "@octokit/rest";
import parseDiff, { Chunk, File } from "parse-diff";
import minimatch from "minimatch";
import { GoogleGenerativeAI } from "@google/generative-ai";


const GITHUB_TOKEN: string = core.getInput("GITHUB_TOKEN");
const OPENAI_API_KEY: string = core.getInput("OPENAI_API_KEY");
const OPENAI_API_MODEL: string = core.getInput("OPENAI_API_MODEL");
const GOOGLE_GENERATIVE_AI_API_KEY: string = core.getInput("GOOGLE_GENERATIVE_AI_API_KEY");
const GOOGLE_GENERATIVE_AI_MODEL: string = core.getInput("GOOGLE_GENERATIVE_AI_MODEL") || "gemini-1.5-flash";
const AI_VENDOR: string = core.getInput("AI_VENDOR");
const REVIEW_ENABLED: string = core.getInput("REVIEW_ENABLED") || "false";

console.log("GITHUB_TOKEN:", GITHUB_TOKEN);
console.log("OPENAI_API_KEY:", OPENAI_API_KEY);
console.log("OPENAI_API_MODEL:", OPENAI_API_MODEL);
console.log("GOOGLE_GENERATIVE_AI_API_KEY:", GOOGLE_GENERATIVE_AI_API_KEY);
console.log("GOOGLE_GENERATIVE_AI_MODEL:", GOOGLE_GENERATIVE_AI_MODEL);
console.log("AI_VENDOR:", AI_VENDOR);

const octokit = new Octokit({ auth: GITHUB_TOKEN });

const openai = new OpenAI({
  apiKey: OPENAI_API_KEY,
});

const googlai = new GoogleGenerativeAI(GOOGLE_GENERATIVE_AI_API_KEY);
const googleModel = googlai.getGenerativeModel({ model: GOOGLE_GENERATIVE_AI_MODEL, generationConfig: { responseMimeType: "application/json" }});

interface PRDetails {
  owner: string;
  repo: string;
  pull_number: number;
  title: string;
  description: string;
}

async function getPRDetails(): Promise<PRDetails> {
  const { repository, number } = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH || "", "utf8")
  );
  const prResponse = await octokit.pulls.get({
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
  });
  return {
    owner: repository.owner.login,
    repo: repository.name,
    pull_number: number,
    title: prResponse.data.title ?? "",
    description: prResponse.data.body ?? "",
  };
}

async function getDiff(
  owner: string,
  repo: string,
  pull_number: number
): Promise<string | null> {
  const response = await octokit.pulls.get({
    owner,
    repo,
    pull_number,
    mediaType: { format: "diff" },
  });
  // @ts-expect-error - response.data is a string
  return response.data;
}

async function analyzeCode(
  parsedDiff: File[],
  prDetails: PRDetails
// ): Promise<Array<{ body: string; path: string; line: number }>> {
): Promise<void> {
  const comments: Array<{ body: string; path: string; line: number }> = [];

  for (const file of parsedDiff) {
    console.log("File:", file);
    if (file.to === "/dev/null") continue; // Ignore deleted files
    for (const chunk of file.chunks) {
      const prompt = createPrompt(file, chunk, prDetails);
      const aiResponse = await getAIResponse(prompt);
      // handle the case where the AI response is 429
      // if (aiResponse === null) {
      //   console.log("AI response is 429. Retrying in 1 minutes...");
      //   await new Promise((resolve) => setTimeout(resolve, 65000)); // Sleep for 1 minutes
      //   continue;


      if (aiResponse) {
        const newComments = createComment(file, chunk, aiResponse);
        if (newComments.length > 0) {
          await createReviewComment(
            prDetails.owner,
            prDetails.repo,
            prDetails.pull_number,
            newComments
          );
          // comments.push(...newComments);
        }
      }
      // await new Promise((resolve) => setTimeout(resolve, 5000)); // Sleep for 5 seconds
    }
  }
  // return comments;
}

function createPrompt(file: File, chunk: Chunk, prDetails: PRDetails): string {
  return `Your task is to review pull requests. Instructions:
- Provide the response in following JSON format:  {"reviews": [{"lineNumber":  <line_number>, "reviewComment": "<review comment>"}]}
- Do not give positive comments or compliments.
- Provide comments and suggestions ONLY if there is something to improve, otherwise "reviews" should be an empty array.
- Write the comment in GitHub Markdown format.
- Use the given description only for the overall context and only comment the code.
- IMPORTANT: NEVER suggest adding comments to the code.
- IMPORTANT: NEVER suggest explain the code.

Review the following code diff in the file "${
    file.to
  }" and take the pull request title and description into account when writing the response.

Pull request title: ${prDetails.title}
Pull request description:

---
${prDetails.description}
---

Git diff to review:

\`\`\`diff
${chunk.content}
${chunk.changes
  // @ts-expect-error - ln and ln2 exists where needed
  .map((c) => `${c.ln ? c.ln : c.ln2} ${c.content}`)
  .join("\n")}
\`\`\`
`;
}

async function getOpenAIResponse(prompt: string): Promise<Array<{
  lineNumber: string;
  reviewComment: string;
}> | null> {

  const queryConfig = {
    model: OPENAI_API_MODEL,
    temperature: 0.2,
    max_tokens: 700,
    top_p: 1,
    frequency_penalty: 0,
    presence_penalty: 0,
  };

  try {
    const response = await openai.chat.completions.create({
      ...queryConfig,
      // return JSON if the model supports it:
      ...(OPENAI_API_MODEL === "gpt-4-1106-preview"
        ? { response_format: { type: "json_object" } }
        : {}),
      messages: [
        {
          role: "system",
          content: prompt,
        },
      ],
    });

    const res = response.choices[0].message?.content?.trim() || "{}";
    return JSON.parse(res).reviews;
  } catch (error) {
    console.error("Error:", error);
    return null;
  }

}

async function getGoogleAIResponse(prompt: string): Promise<Array<{
  lineNumber: string;
  reviewComment: string;
}> | null> {

  try {

  const result = await googleModel.generateContent(prompt);
  const response = await result.response;
  const res = response.text() || "{}";

  console.log("==================Reviews:=======================");
  console.log(res);
  console.log("=================================================");

  return JSON.parse(res).reviews;
} catch (error) {
  console.error("Error:", error);
  return null;
}

}

async function getAIResponse(prompt: string) {
  if (AI_VENDOR === "google") {
    return await getGoogleAIResponse(prompt);
  } else if (AI_VENDOR === "openai") {
    return await getOpenAIResponse(prompt);
  }
}

function createComment(
  file: File,
  chunk: Chunk,
  aiResponses: Array<{
    lineNumber: string;
    reviewComment: string;
  }>
): Array<{ body: string; path: string; line: number }> {
  return aiResponses.flatMap((aiResponse) => {
    if (!file.to) {
      return [];
    }
    return {
      body: aiResponse.reviewComment,
      path: file.to,
      line: Number(aiResponse.lineNumber),
    };
  });
}

async function createReviewComment(
  owner: string,
  repo: string,
  pull_number: number,
  comments: Array<{ body: string; path: string; line: number }>
): Promise<void> {
  try {
    await octokit.pulls.createReview({
      owner,
      repo,
      pull_number,
      comments,
      event: "COMMENT",
    });
  }
  catch (error) {
    console.error("Error:", error);
  }
}

async function main() {
  if(REVIEW_ENABLED === "false") {
    console.log("Review is disabled");
    return;
  }
  const prDetails = await getPRDetails();
  console.log("PR Details:", prDetails);

  let diff: string | null;
  const eventData = JSON.parse(
    readFileSync(process.env.GITHUB_EVENT_PATH ?? "", "utf8")
  );
  if (eventData.action === "opened") {
    diff = await getDiff(
      prDetails.owner,
      prDetails.repo,
      prDetails.pull_number
    );
  } else if (eventData.action === "synchronize") {
    const newBaseSha = eventData.before;
    const newHeadSha = eventData.after;

    const response = await octokit.repos.compareCommits({
      headers: {
        accept: "application/vnd.github.v3.diff",
      },
      owner: prDetails.owner,
      repo: prDetails.repo,
      base: newBaseSha,
      head: newHeadSha,
    });

    diff = String(response.data);
    console.log("Diff:", diff);
  } else {
    console.log("Unsupported event:", process.env.GITHUB_EVENT_NAME);
    return;
  }

  if (!diff) {
    console.log("No diff found");
    return;
  }

  const parsedDiff = parseDiff(diff);

  console.log("Parsed Diff:", parsedDiff);

  const excludePatterns = core
    .getInput("exclude")
    .split(",")
    .map((s) => s.trim());

  const filteredDiff = parsedDiff.filter((file) => {
    return !excludePatterns.some((pattern) =>
      minimatch(file.to ?? "", pattern)
    );
  });

  console.log("Filtered Diff:", filteredDiff);

  await analyzeCode(filteredDiff, prDetails);

  // const comments = await analyzeCode(filteredDiff, prDetails);
  // if (comments.length > 0) {

  //   await createReviewComment(
  //     prDetails.owner,
  //     prDetails.repo,
  //     prDetails.pull_number,
  //     comments
  //   );
  // }
}

main().catch((error) => {
  console.error("Error:", error);
  process.exit(1);
});
