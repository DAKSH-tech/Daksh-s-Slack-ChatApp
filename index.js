import pkg from "@slack/bolt";
const { App, ExpressReceiver } = pkg;
import dotenv from "dotenv";
import OpenAI from "openai";
import express from "express";
import { pushUserEvent } from "./src/redisClient.js";
import { deleteMsgHandler } from "./src/redisClient.js";

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
const expressApp = receiver.app;
expressApp.use(express.json());

// expressApp.post("/", (req, res, next) => {
//   const { body } = req;
//   const challenge = body?.challenge;
//   console.log("Received body:", body);
//   console.log("Received challenge:", challenge);
//   res.send(challenge || "no challenge");
// });

// --- Local POST endpoint to test OpenAI ---
expressApp.post("/chat", async (req, res) => {
  const { userId, message } = req.body;

  if (!userId || !message) {
    return res.status(400).json({ error: "userId and message are required" });
  }

  const answer = await askChatGPTWithMemory(userId, message);
  res.json({ reply: answer });
});

expressApp.post("/", async (req, res) => {
  const { body } = req;
  // Only process event callbacks
  if (body.type === "event_callback" && body.event?.type === "app_mention") {
    const event = body.event;
    const userMessage = event.text.replace(/<@[^>]+>\s*/, "").trim();

    try {
      await pushUserEvent(event.user, userMessage, event);

      // Respond immediately with acknowledgment (optional)
      await client.chat.postMessage({
        channel: event.channel,
        thread_ts: event.ts,
        text: "...",
      });
      res.status(200).send("Event received");
    } catch (err) {
      console.error("Error sending Slack reply:", err);
    }
  } else if (
    body.event.subtype === "message_deleted" ||
    (body.event.subtype === "message_changed" &&
      body.event.message?.subtype === "tombstone")
  ) {
    await deleteMsgHandler(body.event);
    res.status(200).send("Deletion event handled");
  } else {
    res.status(200).send("No action taken");
  }
});

// --- Start server ---
(async () => {
  const PORT = process.env.PORT || 3001;
  await app.start(PORT);
  console.log(`⚡️ Warpi bot is running on port ${PORT}`);
})();
