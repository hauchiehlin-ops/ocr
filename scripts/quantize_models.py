#!/usr/bin/env python3
"""
Model Quantization Script — Compresses ONNX models using INT8 dynamic quantization.
This script reduces model size by ~4x and speeds up CPU/GPU edge inference.

Usage:
  python quantize_models.py --input <path_to_model.onnx> --output <path_to_quant_model.onnx>
"""

import os
import sys
import argparse

def main():
    parser = argparse.ArgumentParser(description="Quantize ONNX models to dynamic INT8")
    parser.add_argument("-i", "--input", required=True, help="Input ONNX model file path")
    parser.add_argument("-o", "--output", required=True, help="Output quantized ONNX model file path")
    args = parser.parse_args()

    if not os.path.exists(args.input):
        print(f"Error: Input model file not found: {args.input}")
        sys.exit(1)

    try:
        import onnx
        from onnxruntime.quantization import quantize_dynamic, QuantType
    except ImportError:
        print("Required libraries missing. Please run: pip install onnx onnxruntime")
        sys.exit(1)

    print(f"Quantizing model: {args.input} -> {args.output}")
    try:
        quantize_dynamic(
            model_input=args.input,
            model_output=args.output,
            weight_type=QuantType.QUInt8
        )
        print("✅ Quantization completed successfully!")
        
        orig_size = os.path.getsize(args.input) / (1024 * 1024)
        quant_size = os.path.getsize(args.output) / (1024 * 1024)
        print(f"Original size: {orig_size:.2f} MB")
        print(f"Quantized size: {quant_size:.2f} MB (Compression ratio: {orig_size/quant_size:.2f}x)")
    except Exception as e:
        print(f"❌ Quantization failed: {str(e)}")
        sys.exit(2)

if __name__ == "__main__":
    main()
