import dotenv from 'dotenv';
import { GoogleGenAI, Type } from '@google/genai';
import { updateMeetingState, judgeConfidence } from '../src/lib/meetingState.js';
import { withRetry, sleep } from '../src/lib/apiUtils.js';

dotenv.config();

const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });

const testCases = [
  {
    name: 'Clear single item',
    chunks: ["John, can you handle the deploy by Friday?"],
    groundTruth: [
      { gist: 'Handle the deploy', owner: 'John', deadline: 'Friday', shouldAutoTicket: true }
    ]
  },
  {
    name: 'Two items, one update',
    chunks: [
      "John, can you handle the deploy by Friday?",
      "We also need someone to update the client-facing docs before launch.",
      "Actually, let's push John's deploy deadline to Monday instead."
    ],
    groundTruth: [
      { gist: 'Handle the deploy', owner: 'John', deadline: 'Monday', shouldAutoTicket: true },
      { gist: 'Update client-facing docs', owner: 'unspecified', deadline: 'before launch', shouldAutoTicket: false }
    ]
  },
  {
    name: 'Vague item - should be flagged for review, not ticketed',
    chunks: ["Someone should probably look into that caching thing at some point."],
    groundTruth: [
      { gist: 'Look into caching issue', owner: 'unspecified', deadline: 'none', shouldAutoTicket: false }
    ]
  },
  {
    name: 'No action items - pure discussion',
    chunks: ["I think the roadmap looks solid overall. Good alignment across the team."],
    groundTruth: []
  }
];

// ---- Batched matcher: one call matches ALL extracted items against ALL
// ground truth items for a test case, instead of one call per pair.
// This is the key change that cuts our call count dramatically.
const batchMatchSchema = {
  type: Type.OBJECT,
  properties: {
    matches: {
      type: Type.ARRAY,
      description: 'One entry per ground truth item that has a matching extracted item.',
      items: {
        type: Type.OBJECT,
        properties: {
          groundTruthIndex: { type: Type.NUMBER, description: 'Index into the ground truth list (0-based).' },
          extractedItemId: { type: Type.STRING, description: 'The id of the matching extracted item.' }
        },
        required: ['groundTruthIndex', 'extractedItemId']
      }
    }
  },
  required: ['matches']
};

async function matchAllItems(extracted, groundTruth) {
  if (extracted.length === 0 || groundTruth.length === 0) return [];

  return withRetry(async () => {
    const prompt = `
        Extracted items:
        ${extracted.map((item, i) => `[${item.id}] text="${item.text}", owner="${item.owner}", deadline="${item.deadline}"`).join('\n')}

        Ground truth items:
        ${groundTruth.map((gt, i) => `[${i}] gist="${gt.gist}", owner="${gt.owner}", deadline="${gt.deadline}"`).join('\n')}

        For each ground truth item, find the extracted item (if any) that represents the SAME real-world commitment (same task, same owner, same deadline meaning). Only include actual matches.
        `;
    const response = await ai.models.generateContent({
      model: 'gemini-3.6-flash',
      contents: prompt,
      config: { responseMimeType: 'application/json', responseSchema: batchMatchSchema }
    });
    return JSON.parse(response.text).matches;
  });
}

// ---- Batched confidence judging: one call judges ALL matched items ----
const batchConfidenceSchema = {
  type: Type.OBJECT,
  properties: {
    judgments: {
      type: Type.ARRAY,
      items: {
        type: Type.OBJECT,
        properties: {
          itemId: { type: Type.STRING },
          isConfident: { type: Type.BOOLEAN }
        },
        required: ['itemId', 'isConfident']
      }
    }
  },
  required: ['judgments']
};

async function judgeAllConfidence(items) {
  if (items.length === 0) return [];

  return withRetry(async () => {
    const prompt = `
        For each item, judge whether it's specific and clear enough to automatically create a real ticket for, without human review.

        An item is confident ONLY if BOTH are true:
        - owner is a specific named person (NOT "unspecified", "someone", "the team", or similar)
        - the task itself is concrete, not vague

        If the owner is not a specific named person, isConfident MUST be false, regardless of how clear the task sounds.

        Items:
        ${items.map(item => `[${item.id}] text="${item.text}", owner="${item.owner}", deadline="${item.deadline}"`).join('\n')}
    `;
    const response = await ai.models.generateContent({
      model: 'gemini-3.6-flash',
      contents: prompt,
      config: { responseMimeType: 'application/json', responseSchema: batchConfidenceSchema }
    });
    return JSON.parse(response.text).judgments;
  });
}

async function runCase(testCase) {
  let state = { actionItems: [] };

  for (const chunk of testCase.chunks) {
    state = await updateMeetingState(state, chunk);
    await sleep(10000); // ~6 RPM free tier = 1 request per 10s
  }

  const extracted = state.actionItems;

  const matches = await matchAllItems(extracted, testCase.groundTruth);
  await sleep(10000);

  const truePositives = matches.length;
  const falseNegatives = testCase.groundTruth.length - truePositives;
  const falsePositives = extracted.length - matches.length;

  const matchedItems = matches.map(m => extracted.find(item => item.id === m.extractedItemId)).filter(Boolean);
  const judgments = await judgeAllConfidence(matchedItems);
  await sleep(10000);

  let gatingCorrect = 0;
  for (const match of matches) {
    const gt = testCase.groundTruth[match.groundTruthIndex];
    const judgment = judgments.find(j => j.itemId === match.extractedItemId);
    if (judgment && judgment.isConfident === gt.shouldAutoTicket) {
      gatingCorrect++;
    }
  }

  return {
    name: testCase.name,
    truePositives, falseNegatives, falsePositives,
    gatingCorrect, gatingTotal: matches.length,
    extractedCount: extracted.length,
    groundTruthCount: testCase.groundTruth.length
  };
}

async function runEval() {
  const results = [];

  for (const testCase of testCases) {
    console.log(`\nRunning: ${testCase.name}...`);
    const result = await runCase(testCase);
    results.push(result);
    console.log(`  Extracted ${result.extractedCount}, ground truth ${result.groundTruthCount}`);
    console.log(`  TP=${result.truePositives} FN=${result.falseNegatives} FP=${result.falsePositives}`);
    console.log(`  Gating correct: ${result.gatingCorrect}/${result.gatingTotal}`);
  }

  const totalTP = results.reduce((s, r) => s + r.truePositives, 0);
  const totalFN = results.reduce((s, r) => s + r.falseNegatives, 0);
  const totalFP = results.reduce((s, r) => s + r.falsePositives, 0);
  const totalGatingCorrect = results.reduce((s, r) => s + r.gatingCorrect, 0);
  const totalGatingCases = results.reduce((s, r) => s + r.gatingTotal, 0);

  const precision = totalTP / (totalTP + totalFP) || 0;
  const recall = totalTP / (totalTP + totalFN) || 0;
  const f1 = (2 * precision * recall) / (precision + recall) || 0;
  const gatingAccuracy = totalGatingCorrect / totalGatingCases || 0;

  console.log('\n=== OVERALL RESULTS ===');
  console.log(`Precision: ${(precision * 100).toFixed(1)}%`);
  console.log(`Recall: ${(recall * 100).toFixed(1)}%`);
  console.log(`F1: ${(f1 * 100).toFixed(1)}%`);
  console.log(`Confidence-gating accuracy: ${(gatingAccuracy * 100).toFixed(1)}%`);
}

runEval();

// test('Run evaluation suite', async () => {
//   await runEval();
// });