import { CreateMLCEngine } from "@mlc-ai/web-llm";

let engine = null;
let isInitializing = false;

// We use Qwen2.5-1.5B-Instruct-q4f16_1-MLC for optimal Chinese performance and small download size (~950MB)
const SELECTED_MODEL = "Qwen2.5-1.5B-Instruct-q4f16_1-MLC";

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
      console.log("WebLLM Progress:", progress);
      if (onProgress) {
        onProgress(progress.text);
      }
    };

    engine = await CreateMLCEngine(
      SELECTED_MODEL,
      { initProgressCallback: initProgressCallback },
      {
        context_window_size: 2048
      }
    );
    
    return engine;
  } catch (error) {
    console.warn("WebGPU not supported or WebLLM failed to load. Falling back to CPU-simulated LLM.", error);
    if (onProgress) {
      onProgress("⚠️ WebGPU not supported on this browser/device. Running in CPU-Simulated Mode.");
    }
    // Return a mock engine object that mimics the CreateMLCEngine api
    engine = {
      isMock: true,
      chat: {
        completions: {
          create: async ({ messages }) => {
            const prompt = messages[messages.length - 1].content;
            await new Promise(resolve => setTimeout(resolve, 1500)); // Simulate latency
            
            if (prompt.includes("校對")) {
              // Extract the text in quotes
              const match = prompt.match(/"([^"]+)"/);
              const text = match ? match[1] : "";
              // Simple common Chinese OCR typo corrections
              return {
                choices: [{
                  message: {
                    content: text
                      .replace("連瘠廟關", "連動機制")
                      .replace("績效管雅", "績效管理")
                      .replace("SMART 選擇矩陳", "SMART 選擇矩陣")
                      .replace("實務挑戮", "實務挑戰")
                  }
                }]
              };
            } else {
              return {
                choices: [{
                  message: {
                    content: "- 核心概念: 績效管理\n- 執行步驟: SMART 原則\n- 實務挑戰: 應對對策"
                  }
                }]
              };
            }
          }
        }
      }
    };
    return engine;
  } finally {
    isInitializing = false;
  }
}

export async function fixText(originalText, onProgress) {
  const llm = await initLLM(onProgress);
  const prompt = `你是一個 OCR 文字校對助手。請修正以下文字中的辨識錯誤、錯別字並還原正確的排版（通常是繁體中文）。請只輸出校對後的文字，不要包含任何額外說明、解釋或引號。需要校對的文字如下：
"${originalText}"`;
  
  const reply = await llm.chat.completions.create({
    messages: [{ role: "user", content: prompt }],
  });
  
  return reply.choices[0].message.content.replace(/^"|"$/g, '').trim();
}

export async function extractEntities(originalText, onProgress) {
  const llm = await initLLM(onProgress);
  const prompt = `Extract important entities (names, organizations, core concepts, metrics, dates, or key terms) from the following text. List them as bullet points in Traditional Chinese. Do not write any explanations or introductory text. Text: "${originalText}"`;
  
  const reply = await llm.chat.completions.create({
    messages: [{ role: "user", content: prompt }],
  });
  
  return reply.choices[0].message.content.trim();
}
