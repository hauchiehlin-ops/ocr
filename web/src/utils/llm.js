import { CreateMLCEngine } from "@mlc-ai/web-llm";

let engine = null;
let isInitializing = false;

// We use a small model for browser performance
const SELECTED_MODEL = "Llama-3-8B-Instruct-q4f32_1-MLC";

export async function initLLM(onProgress) {
  if (engine) return engine;
  if (isInitializing) {
    // Wait until engine is initialized
    while(isInitializing) {
        await new Promise(resolve => setTimeout(resolve, 500));
    }
    return engine;
  }

  isInitializing = true;
  try {
    const initProgressCallback = (progress) => {
      console.log(progress);
      if (onProgress) onProgress(progress.text);
    };

    engine = await CreateMLCEngine(
      SELECTED_MODEL,
      { initProgressCallback: initProgressCallback },
      {
        context_window_size: 2048 // keep it small for OCR tasks
      }
    );
    
    return engine;
  } catch (error) {
    console.error("Failed to initialize WebLLM:", error);
    throw error;
  } finally {
    isInitializing = false;
  }
}

export async function fixText(originalText) {
  const llm = await initLLM();
  const prompt = `Fix any OCR errors in the following text. Only output the corrected text, nothing else. Text: "${originalText}"`;
  
  const reply = await llm.chat.completions.create({
    messages: [{ role: "user", content: prompt }],
  });
  
  return reply.choices[0].message.content.replace(/^"|"$/g, '').trim();
}

export async function translateText(originalText, targetLang = "Traditional Chinese") {
  const llm = await initLLM();
  const prompt = `Translate the following text to ${targetLang}. Only output the translation, nothing else. Text: "${originalText}"`;
  
  const reply = await llm.chat.completions.create({
    messages: [{ role: "user", content: prompt }],
  });
  
  return reply.choices[0].message.content.replace(/^"|"$/g, '').trim();
}
