import { GoogleGenerativeAI } from "@google/generative-ai";
import { NextRequest } from "next/server";

/**
 * Splits a story into visual scenes using Gemini, then generates
 * images using Gemini 2.5 Flash Image model (native image generation).
 * Returns scene data with base64 image data URLs for instant display.
 */

const IMAGE_MODEL = "gemini-2.5-flash-image";

async function generateImageWithGemini(prompt: string): Promise<string> {
  const apiKey = process.env.GEMINI_API_KEY;
  const url = `https://generativelanguage.googleapis.com/v1beta/models/${IMAGE_MODEL}:generateContent`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": apiKey!,
    },
    body: JSON.stringify({
      contents: [{ parts: [{ text: `Generate a cinematic widescreen image: ${prompt}` }] }],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
      },
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    console.error(`Gemini image gen failed [${res.status}]:`, errText);
    throw new Error(`Gemini image generation failed: ${res.status}`);
  }

  const data = await res.json();
  const parts = data.candidates?.[0]?.content?.parts ?? [];

  for (const part of parts) {
    if (part.inlineData?.data) {
      const mime = part.inlineData.mimeType || "image/png";
      return `data:${mime};base64,${part.inlineData.data}`;
    }
  }

  throw new Error("No image in Gemini response");
}

export async function POST(req: NextRequest) {
  try {
    const { content, genre } = await req.json();
    if (!content) {
      return Response.json({ error: "Content is required" }, { status: 400 });
    }

    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
    const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

    const result = await model.generateContent(`You are a cinematic storyboard director. Split this ${genre} story into exactly 3 visual scenes for illustration.

STORY:
${content.slice(0, 2000)}

For each scene, provide:
1. The EXACT text from the story that belongs to this scene (copy it word-for-word, include ALL text, don't skip any part)
2. A SHORT visual description for an AI image generator (what the camera sees — setting, characters, lighting, mood). Keep it under 30 words.

Return ONLY valid JSON (no markdown, no code blocks):
{
  "scenes": [
    {
      "text": "<exact story text for this scene>",
      "visual": "<visual description, under 30 words>"
    }
  ]
}

RULES:
- Split into exactly 3 scenes covering the ENTIRE story text
- Every word of the story must appear in exactly one scene
- The visual should describe what a viewer SEES, not narrate
- Match the ${genre} aesthetic`);

    let scenes: { text: string; visual: string }[];

    try {
      const text = result.response.text().trim();
      const jsonStr = text.replace(/```json\n?/g, "").replace(/```\n?/g, "").trim();
      const parsed = JSON.parse(jsonStr);
      scenes = parsed.scenes || [];
    } catch {
      const paragraphs = content
        .split(/\n\n+/)
        .filter((p: string) => p.trim().length > 20);

      scenes = paragraphs.slice(0, 3).map((p: string) => ({
        text: p.trim(),
        visual: `Cinematic ${genre} scene: ${p.trim().slice(0, 80)}`,
      }));
    }

    scenes = scenes.slice(0, 3);

    // Generate all 3 images in parallel with Gemini 2.5 Flash Image
    console.log(`Generating ${scenes.length} images with Gemini 2.5 Flash Image...`);
    const imageResults = await Promise.all(
      scenes.map((scene, i) => {
        const imagePrompt = `${scene.visual}, ${genre} style, cinematic, digital art, dramatic lighting, widescreen 16:9`;
        return generateImageWithGemini(imagePrompt).then(url => ({ i, url }));
      })
    );

    const scenesWithImages = scenes.map((scene, i) => ({
      sceneNumber: i + 1,
      text: scene.text,
      visual: scene.visual,
      imageUrl: imageResults.find(r => r.i === i)?.url ?? "",
      wordCount: scene.text.split(/\s+/).length,
    }));

    const totalWords = scenesWithImages.reduce((sum, s) => sum + s.wordCount, 0);

    return Response.json({
      success: true,
      scenes: scenesWithImages,
      totalScenes: scenesWithImages.length,
      totalWords,
    });
  } catch (error) {
    console.error("Scene generation error:", error);
    return Response.json({ error: "Failed to generate scenes" }, { status: 500 });
  }
}
