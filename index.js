import pkg from "@slack/bolt";
const { App, ExpressReceiver } = pkg;
import dotenv from "dotenv";
import OpenAI from "openai";
import express from "express";
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
  receiver, // Important to use ExpressReceiver
});

// --- Express App ---
const expressApp = receiver.app; // Reuse the same Express instance
expressApp.use(express.json());

// expressApp.post("/", (req, res, next) => {
//   const { body } = req;
//   const challenge = body?.challenge;
//   console.log("Received body:", body);
//   console.log("Received challenge:", challenge);
//   res.send(challenge || "no challenge");
// });

// --- Simple memory store ---
const userMemory = new Map();

// --- Ask OpenAI with memory (5-message history + current question) ---
async function askChatGPTWithMemory(userId, question) {
  if (!userMemory.has(userId)) userMemory.set(userId, []);
  const memory = userMemory.get(userId);

  // Take only last 5 messages
  const recentMemory = memory.slice(-5);

  // Build messages array with system + last 5 + current question
  const messages = [
    { role: "system", content: "You are a helpful assistant named Warpi." },
    ...recentMemory,
    { role: "user", content: question },
  ];

  try {
    const response = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      messages,
    });

    const answer = response.choices[0].message.content.trim();

    // Update memory: push user question + assistant answer
    memory.push({ role: "user", content: question });
    memory.push({ role: "assistant", content: answer });

    // Keep only last 5 messages in memory
    if (memory.length > 5) {
      userMemory.set(userId, memory.slice(-5));
    } else {
      userMemory.set(userId, memory);
    }

    return answer;
  } catch (err) {
    console.error("OpenAI API error:", err);
    return "Sorry, I ran into an error while trying to respond.";
  }
}
// --- GET endpoint to view user memory ---
expressApp.get("/memory/:userId", (req, res) => {
  const { userId } = req.params;

  if (!userId) {
    return res.status(400).json({ error: "userId is required" });
  }

  const memory = userMemory.get(userId) || [];
  res.json({ userId, memory });
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

app.event("app_mention", async ({ event, client }) => {
  try {
    console.log("app_mention event received:", event);
    // Remove the bot mention from the message text
    const userMessage = event.text.replace(/<@[^>]+>\s*/, "").trim();
    console.log("app_mention event asking from chatgpt with msg:", userMessage);
    // Get the bot's response using your memory function
    const answer = await askChatGPTWithMemory(event.user, userMessage);
    console.log("app_mention event answer from chatgpt:", answer);
    // Reply in the same thread where the mention happened
    await client.chat.postMessage({
      channel: event.channel,
      thread_ts: event.ts, // This makes the reply threaded
      text: answer,
    });
    console.log("app_mention event ends:", answer);
  } catch (err) {
    console.error("Slack bot error:", err);
  }
});

// --- Start server ---
(async () => {
  const PORT = process.env.PORT || 3000;
  await app.start(PORT);
  console.log(`⚡️ Warpi bot is running on port ${PORT}`);
})();
