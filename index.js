import pkg from "@slack/bolt";
const { App, ExpressReceiver } = pkg;
import express from "express";
import dotenv from "dotenv";
import OpenAI from "openai";

dotenv.config();

// --- OpenAI ---
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

// --- Slack Receiver ---
const receiver = new ExpressReceiver({
  signingSecret: process.env.SLACK_SIGNING_SECRET,
});

// --- Slack App ---
const app = new App({
  token: process.env.SLACK_BOT_TOKEN,
  receiver, // <--- important
});

// --- Express App ---
const expressApp = receiver.app; // reuse same Express inside Slack
expressApp.use(express.json());

// --- Simple memory store ---
const userMemory = new Map();

// --- Ask OpenAI with memory ---
async function askChatGPTWithMemory(userId, question) {
  if (!userMemory.has(userId)) userMemory.set(userId, []);
  const memory = userMemory.get(userId);

  memory.push({ role: "user", content: question });
  if (memory.length > 5) memory.shift();

  const messages = [
    { role: "system", content: "You are a helpful assistant named Warpi." },
    ...memory,
  ];

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
    });

    const answer = response.choices[0].message.content.trim();

    memory.push({ role: "assistant", content: answer });
    if (memory.length > 5) memory.shift();

    userMemory.set(userId, memory);
    return answer;
  } catch (err) {
    console.error("OpenAI API error:", err);
    return "Sorry, I ran into an error while trying to respond.";
  }
}

// --- Slack event handler ---
app.event("app_mention", async ({ event, client }) => {
  try {
    const userMessage = event.text.replace(/<@[^>]+>/, "").trim();
    const answer = await askChatGPTWithMemory(event.user, userMessage);

    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts,
      text: answer,
    });
  } catch (err) {
    console.error("Slack bot error:", err);
  }
});

// --- Local POST endpoint to test OpenAI ---
expressApp.post("/chat", async (req, res) => {
  const { userId, message } = req.body;

  if (!userId || !message) {
    return res.status(400).json({ error: "userId and message are required" });
  }

  const answer = await askChatGPTWithMemory(userId, message);
  res.json({ reply: answer });
});

// --- Start server ---
const PORT = process.env.PORT || 3000;
expressApp.listen(PORT, async () => {
  await app.start();
  console.log(`⚡️ Warpi bot is running on http://localhost:${PORT}`);
});
