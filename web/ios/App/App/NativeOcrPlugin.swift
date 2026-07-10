import Capacitor
import UIKit
import Vision

@objc(NativeOcrPlugin)
public class NativeOcrPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "NativeOcrPlugin"
    public let jsName = "NativeOcr"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "recognize", returnType: CAPPluginReturnPromise)
    ]

    @objc func recognize(_ call: CAPPluginCall) {
        guard let imageData = call.getString("image"), !imageData.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty else {
            call.reject("Missing image data.")
            return
        }

        DispatchQueue.global(qos: .userInitiated).async {
            do {
                let cgImage = try self.decodeCGImage(from: imageData)
                let results = try self.recognizeText(in: cgImage)
                DispatchQueue.main.async {
                    call.resolve([
                        "engine": "iOS Apple Vision",
                        "results": results
                    ])
                }
            } catch {
                DispatchQueue.main.async {
                    call.reject("iOS Apple Vision OCR failed: \(error.localizedDescription)")
                }
            }
        }
    }

    private func decodeCGImage(from imageData: String) throws -> CGImage {
        let payload: String
        if let commaIndex = imageData.firstIndex(of: ",") {
            payload = String(imageData[imageData.index(after: commaIndex)...])
        } else {
            payload = imageData
        }

        guard let data = Data(base64Encoded: payload),
              let image = UIImage(data: data),
              let cgImage = image.cgImage else {
            throw NativeOcrError.invalidImageData
        }

        return cgImage
    }

    private func recognizeText(in cgImage: CGImage) throws -> [[String: Any]] {
        var output: [[String: Any]] = []
        var requestError: Error?

        let request = VNRecognizeTextRequest { request, error in
            requestError = error
            guard let observations = request.results as? [VNRecognizedTextObservation] else {
                return
            }

            output = observations.compactMap { observation in
                guard let candidate = observation.topCandidates(1).first else {
                    return nil
                }
                let text = candidate.string.trimmingCharacters(in: .whitespacesAndNewlines)
                guard !text.isEmpty else {
                    return nil
                }

                return [
                    "text": text,
                    "bbox": self.normalizeVisionBoundingBox(observation.boundingBox),
                    "confidence": Double(candidate.confidence),
                    "source": "ios-vision"
                ]
            }
        }

        request.recognitionLevel = .accurate
        request.usesLanguageCorrection = true
        request.recognitionLanguages = ["zh-Hant", "zh-Hans", "en-US"]

        let handler = VNImageRequestHandler(cgImage: cgImage, orientation: .up, options: [:])
        try handler.perform([request])

        if let requestError = requestError {
            throw requestError
        }

        return output
    }

    private func normalizeVisionBoundingBox(_ box: CGRect) -> [Int] {
        let xmin = clampToThousand(box.minX * 1000)
        let xmax = clampToThousand(box.maxX * 1000)
        let ymin = clampToThousand((1 - box.maxY) * 1000)
        let ymax = clampToThousand((1 - box.minY) * 1000)
        return [ymin, xmin, ymax, xmax]
    }

    private func clampToThousand(_ value: CGFloat) -> Int {
        return max(0, min(1000, Int(round(value))))
    }
}

private enum NativeOcrError: LocalizedError {
    case invalidImageData

    var errorDescription: String? {
        switch self {
        case .invalidImageData:
            return "Unable to decode image data."
        }
    }
}
