# LaMa ONNX model

Run `npm run model:setup` from the `web` directory before building or serving
the OCR editor. The command downloads `lama_fp32.onnx` and verifies its SHA-256
checksum before installation.

The model is the fixed 512×512, opset-17 FP32 export from
[`Carve/LaMa-ONNX`](https://huggingface.co/Carve/LaMa-ONNX), derived from the
official [LaMa project](https://github.com/advimman/lama). Both repositories
identify the code/model as Apache-2.0 licensed. The 198 MiB binary is excluded
from Git because it exceeds GitHub's ordinary file limit.

The public fallback URL is pinned to immutable Hugging Face revision
`c3c0c9e468934d62e79c329e35d82dd09ff8c444`, never the mutable `main` branch.
In browsers, both the model and ORT WASM runtime are verified and stored in the
origin's Cache Storage. The app also requests persistent storage where the
browser supports it; users can still remove these files by clearing site data.
