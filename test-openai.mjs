import OpenAI from "openai";

const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
});

const response = await openai.responses.create({
  model: "gpt-4.1-mini",
  input: "Responde solo: OpenAI funcionando correctamente",
});

console.log(response.output_text);
