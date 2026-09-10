import { GoogleGenAI, Type } from '@google/genai';
import dotenv from 'dotenv';

dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const stateSchema = {
  type: Type.OBJECT,
  properties: {
    actionItems: {
      type: Type.ARRAY,
      description: 'The complete, current list of all known action items after processing this chunk.',
      items: {
        type: Type.OBJECT,
        properties: {
          id: { type: Type.STRING, description: 'Stable short identifier, e.g. "item-1". Keep existing IDs unchanged when updating an item.' },
          text: { type: Type.STRING },
          owner: { type: Type.STRING },
          deadline: { type: Type.STRING }
        },
        required: ['id', 'text', 'owner', 'deadline']
      }
    }
  },
  required: ['actionItems']
};

export async function updateMeetingState(currentState, newChunk) {
    const prompt = `
        Current meeting state (JSON):
        ${JSON.stringify(currentState, null, 2)}

        New transcript chunk just spoken:
        "${newChunk}"

        Update the meeting state based on this new chunk. Rules:
        - If the new chunk introduces a genuinely new action item, ADD it with a new id.
        - If the new chunk modifies an EXISTING item (e.g. changes a deadline, reassigns an owner), UPDATE that item in place - keep its existing id, do not create a duplicate.
        - If the new chunk contains no action-item-relevant information, return the state UNCHANGED.
        - Always return the FULL list of all action items (existing + any changes), not just the new ones.
    `;

    const response = await ai.models.generateContent({
        model: 'gemini-3.6-flash',
        contents: prompt,
        config: {
        systemInstruction: 'You are a meeting assistant maintaining a running list of action items. You reconcile new information against existing items rather than duplicating them.',
        responseMimeType: 'application/json',
        responseSchema: stateSchema
        }
    });

    return JSON.parse(response.text);
}

const confidenceSchema = {
    type: Type.OBJECT,
    properties: {
        isConfident: {
        type: Type.BOOLEAN,
        description: 'True only if the item has a clear owner AND a clear, concrete task - safe to act on automatically.'
        },
        reason: { type: Type.STRING, description: 'One short sentence explaining the judgment.' }
    },
    required: ['isConfident', 'reason']
};

export async function judgeConfidence(item) {
        const prompt = `Action item: "${item.text}", owner: "${item.owner}", deadline: "${item.deadline}".
            Is this specific and clear enough to automatically create a real ticket for, without human review?
        `;

    const response = await ai.models.generateContent({
        model: 'gemini-3.6-flash',
        contents: prompt,
        config: {
        systemInstruction: 'You are judging whether an extracted action item is concrete enough to act on automatically. Be conservative - vague owners like "someone" or vague tasks should NOT be confident.',
        responseMimeType: 'application/json',
        responseSchema: confidenceSchema
        }
    });

    return JSON.parse(response.text);
}