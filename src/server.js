import express from "express";
import {WebSocketServer, WebSocket} from "ws";
import http from "http";
import dotenv from "dotenv";
import {updateMeetingState, judgeConfidence} from "./lib/meetingState.js";

dotenv.config();

const API_KEY = process.env.DEEPGRAM_API_KEY;
if(!API_KEY) {
    console.error("DEEPGRAM_API_KEY is not set in the environment variables.");
    process.exit(1);
}
if(!process.env.GEMINI_API_KEY) {
    console.error("GEMINI_API_KEY is not set in the environment variables.");
    process.exit(1);
}
if(!process.env.LINEAR_API_KEY) {
    console.error("LINEAR_API_KEY is not set in the environment variables.");
    process.exit(1);
}

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const DEBOUNCE_INTERVAL = 3000; // 3 seconds

wss.on("connection", (ws) => {
    console.log("Client connected");

    let meetingState = { actionItems: [] };
    let debounceTimer = null;
    let pendingBuffer = "";
    const ticketedItemIds = new Set();

    async function processBuffer() {
        if (pendingBuffer.trim() === "") {
            return;
        }
        const newChunk = pendingBuffer.trim();
        pendingBuffer = "";

        console.log("Processing pending buffer:", newChunk);
        try {
            meetingState = await updateMeetingState(meetingState, newChunk);
            if(ws.readyState === WebSocket.OPEN) {
                ws.send(JSON.stringify({ type: "stateUpdate", state: meetingState }));
            }

            for(const item of meetingState.actionItems) {
                if(ticketedItemIds.has(item.id)) continue;

                const judgement = await judgeConfidence(item);
                console.log(`Judgement for ${item.id} item:`, judgement);
                
                if(judgement.isConfident) {
                    const ticket = await createTicket(item);
                    ticketedItemIds.add(item.id);

                    if(ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: "ticketCreated", itemId: item.id, ticket }));
                    }
                }else{
                    if(ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({ type: "needsReview", itemId: item.id, reason: judgement.reason }));
                    }
                }
                    
            }
        }
        catch (error) {
            console.error("Error updating meeting state:", error);
        }
    }

    const deepgramUrl = `wss://api.deepgram.com/v1/listen?model-nova-2&interim_results=true&smart_format=true&endpointing=500&utterance_end_ms=1500`;
    const deepgramSocket = new WebSocket(deepgramUrl, {
        headers: {
            "Authorization": `token ${API_KEY}`
        }
    });

    let bufferChunks=[];
    let deepgramReady=false;
    deepgramSocket.on("open", () => {
        console.log("Connected to Deepgram WebSocket API");
        deepgramReady=true;
        bufferChunks.forEach(chunk => {
            deepgramSocket.send(chunk);
        });
        bufferChunks=[];
    });

    deepgramSocket.on("message", (message) => {
        const data = JSON.parse(message.toString());
        let transcript = data.channel?.alternatives?.[0]?.transcript || "";
        if(!transcript) {
            return;
        }
        if(ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "transcript", text: transcript, isFinal: data.is_final }));
        }

        if(data.is_final) {
            pendingBuffer += " " + transcript;

            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                processBuffer();
            }, DEBOUNCE_INTERVAL);
        }
    });

    deepgramSocket.on("close", () => {
        console.log("Deepgram WebSocket connection closed");
    });

    deepgramSocket.on("error", (error) => {
        console.error("Deepgram WebSocket error:", error);
    });

    ws.on("message", (message) => {
        if(deepgramReady && deepgramSocket.readyState === WebSocket.OPEN) {
            deepgramSocket.send(message);
        } else {
            bufferChunks.push(message);
        }
    });

    ws.on("close", () => {
        console.log("Client disconnected");
        if(deepgramSocket.readyState === WebSocket.OPEN) {
            deepgramSocket.close();
        }
    });

    ws.on("error", (error) => {
        console.error("WebSocket error:", error);
    });
});

app.get("/", (req, res) => {
    res.send("WebSocket server is running");
});

const PORT = process.env.PORT || 3000;

server.listen(PORT, () => {
    console.log(`Server listening on port ${PORT}`);
});