import sys
import Vision
from Foundation import NSURL

path = sys.argv[1]
url = NSURL.fileURLWithPath_(path)
handler = Vision.VNImageRequestHandler.alloc().initWithURL_options_(url, None)
request = Vision.VNRecognizeTextRequest.alloc().init()
request.setRecognitionLevel_(Vision.VNRequestTextRecognitionLevelAccurate)
request.setUsesLanguageCorrection_(False)
ok = handler.performRequests_error_([request], None)
lines = []
for obs in (request.results() or []):
    text = obs.topCandidates_(1)[0].string()
    box = obs.boundingBox()
    lines.append((round(1 - box.origin.y, 3), round(box.origin.x, 3), text))
for y, x, text in sorted(lines, reverse=True):
    print(f"{y:.3f}\t{x:.3f}\t{text}")
