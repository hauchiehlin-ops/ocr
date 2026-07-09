export async function runGeminiOcr(base64DataUrl, apiKey) {
  // Extract base64 data and mimeType
  const match = base64DataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    throw new Error("Invalid image data format.");
  }
  const mimeType = match[1];
  const base64Data = match[2];

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  const requestBody = {
    contents: [
      {
        parts: [
          {
            text: `Analyze the image and perform extremely high-precision document OCR.
Extract ALL text blocks, lines, labels, words, including very small text, vertically written text, and low-contrast background details.
Output the text in Traditional Chinese (繁體中文) or English exactly as it appears.
For each text segment/line, detect its bounding box coordinates precisely.
Return ONLY a valid JSON array of objects conforming EXACTLY to this schema (no markdown, no quotes, no explanations, no text wrapping block):
[
  {
    "text": "detected text content",
    "bbox": [ymin, xmin, ymax, xmax]
  }
]
Use normalized coordinates in the range [0, 1000] (where 0 is top/left, 1000 is bottom/right). Use [ymin, xmin, ymax, xmax] mapping.
Only return the raw JSON array.`
          },
          {
            inlineData: {
              mimeType: mimeType,
              data: base64Data
            }
          }
        ]
      }
    ],
    generationConfig: {
      responseMimeType: "application/json"
    }
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errText = await response.text();
    let parsedErr;
    try {
      parsedErr = JSON.parse(errText);
    } catch {
      parsedErr = null;
    }
    const errMsg = parsedErr?.error?.message || errText;
    throw new Error(`Gemini API error: ${response.status} - ${errMsg}`);
  }

  const result = await response.json();
  const textResponse = result.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!textResponse) {
    throw new Error("No text response received from Gemini.");
  }

  try {
    // Sanitize markdown code block wraps if any
    let sanitized = textResponse.trim();
    if (sanitized.startsWith("```")) {
      sanitized = sanitized.replace(/^```(?:json)?\n?/, "").replace(/\n?```$/, "");
    }
    
    const blocks = JSON.parse(sanitized.trim());
    if (!Array.isArray(blocks)) {
      throw new Error("Response is not a valid array.");
    }
    return blocks;
  } catch (e) {
    console.error("Failed to parse Gemini response as JSON:", textResponse);
    throw new Error("Gemini returned invalid JSON structure: " + e.message);
  }
}

export async function runGeminiRegionalOcr(base64DataUrl, apiKey) {
  const match = base64DataUrl.match(/^data:([^;]+);base64,(.+)$/);
  if (!match) {
    throw new Error("Invalid image data format.");
  }
  const mimeType = match[1];
  const base64Data = match[2];

  const url = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${apiKey}`;

  const requestBody = {
    contents: [
      {
        parts: [
          {
            text: `Analyze the cropped image segment and perform high-precision document OCR.
Extract all text content present in the image. Keep original line breaks if there are multiple lines.
Output the text in Traditional Chinese (繁體中文) or English exactly as it appears.
Return ONLY the raw recognized text content, nothing else. Do not include markdown, explanations, or JSON formatting.`
          },
          {
            inlineData: {
              mimeType: mimeType,
              data: base64Data
            }
          }
        ]
      }
    ]
  };

  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json"
    },
    body: JSON.stringify(requestBody)
  });

  if (!response.ok) {
    const errText = await response.text();
    let parsedErr;
    try {
      parsedErr = JSON.parse(errText);
    } catch {
      parsedErr = null;
    }
    const errMsg = parsedErr?.error?.message || errText;
    throw new Error(`Gemini API error: ${response.status} - ${errMsg}`);
  }

  const result = await response.json();
  const textResponse = result.candidates?.[0]?.content?.parts?.[0]?.text;
  if (!textResponse) {
    throw new Error("No text response received from Gemini.");
  }

  return textResponse.trim();
}
