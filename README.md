## Setup

1. To use this GitHub Action, you need
- an OpenAI API key. If you don't have one, sign up for an API key at [OpenAI](https://beta.openai.com/signup).
- an Google Gemnini API key. If you don't have one, sign up for an API key at [Gemini](https://ai.google.dev/gemini-api/docs/api-key).

2. Add the OpenAI API key as a GitHub Secret in your repository
- with the name `OPENAI_API_KEY` if use OpenAI.
- with the name `GOOGLE_GENERATIVE_AI_API_KEY` if use Gemini

    You can find more information about GitHub Secrets [here](https://docs.github.com/en/actions/reference/encrypted-secrets).

3. Create a `.github/workflows/main.yml` file in your repository and add the following content:

```yaml
name: AI Code Reviewer

on:
  pull_request:
    types:
      - opened
      - synchronize
permissions: write-all
jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - name: Checkout Repo
        uses: actions/checkout@v3

      - name: AI Code Reviewer
        uses: tmi-quanha/llm-code-review@master
        with:
          GITHUB_TOKEN: ${{ secrets.GITHUB_TOKEN }} # The GITHUB_TOKEN is there by default so you just need to keep it like it is and not necessarily need to add it as secret as it will throw an error. [More Details](https://docs.github.com/en/actions/security-guides/automatic-token-authentication#about-the-github_token-secret)
          OPENAI_API_KEY: ${{ secrets.OPENAI_API_KEY }}
          GOOGLE_GENERATIVE_AI_API_KEY: ${{ secrets.GOOGLE_GENERATIVE_AI_API_KEY }}
          GOOGLE_GENERATIVE_AI_MODEL: ${{ secrets.GOOGLE_GENERATIVE_AI_MODEL }}
          OPENAI_API_MODEL: ${{ secrets.OPENAI_API_MODEL }}
          AI_VENDOR: ${{ secrets.AI_VENDOR }} # Require google or openai
          exclude: "**/*.json, **/*.md" # Optional: exclude patterns separated by commas
```


4. Customize the `exclude` input if you want to ignore certain file patterns from being reviewed.

5. Commit the changes to your repository, and LLM will start working on your future pull requests.

## How It Works

Retrieves the pull request diff, filters out excluded files, and sends code chunks to
the LLM API. It then generates review comments based on the AI's response and adds them to the pull request.

## Contributing

Let the maintainer generate the final package (`yarn build` & `yarn package`).
