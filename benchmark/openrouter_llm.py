import os
from deepeval.models.base_model import DeepEvalBaseLLM
from openai import OpenAI
from dotenv import load_dotenv

load_dotenv()

class OpenRouterLLM(DeepEvalBaseLLM):
    def __init__(self, model="anthropic/claude-3.5-sonnet"):
        self.model = model
        self.client = OpenAI(
            base_url="https://openrouter.ai/api/v1",
            api_key=os.getenv("OPENROUTER_API_KEY"),
        )

    def load_model(self):
        return self.client

    def generate(self, prompt: str) -> str:
        response = self.client.chat.completions.create(
            model=self.model,
            messages=[{"role": "user", "content": prompt}],
        )
        return response.choices[0].message.content

    async def a_generate(self, prompt: str) -> str:
        return self.generate(prompt)

    def get_model_name(self):
        return self.model
