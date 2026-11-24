import Foundation
import AVFoundation
import ScreenCaptureKit
import Speech
import CoreMedia

// Newline-delimited JSON is the only stdout protocol. Audio never goes to disk.
let outputLock = NSLock()
func emit(_ message: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: message) else { return }
    outputLock.lock()
    FileHandle.standardOutput.write(data + Data([10]))
    outputLock.unlock()
}
func failure(_ message: String) -> NSError {
    NSError(domain: "InterviewOverlay.Audio", code: 1, userInfo: [NSLocalizedDescriptionKey: message])
}

final class SpeechChannel {
    let source: String
    let recognizer: SFSpeechRecognizer
    let queue: DispatchQueue
    var request: SFSpeechAudioBufferRecognitionRequest?
    var task: SFSpeechRecognitionTask?
    var timer: DispatchSourceTimer?
    var generation = 0
    var lastText = ""
    let onError: (String) -> Void

    init(source: String, locale: String, queue: DispatchQueue, onError: @escaping (String) -> Void) throws {
        self.source = source
        self.queue = queue
        self.onError = onError
        guard let recognizer = SFSpeechRecognizer(locale: Locale(identifier: locale)),
              recognizer.supportsOnDeviceRecognition else {
            throw failure("On-device speech is unavailable for \(locale). Enable/download that Dictation language in System Settings, or select a configured speech provider in Settings.")
        }
        self.recognizer = recognizer
        restart()
        timer = DispatchSource.makeTimerSource(queue: queue)
        timer?.schedule(deadline: .now() + 50, repeating: 50)
        timer?.setEventHandler { [weak self] in self?.restart() }
        timer?.resume()
    }

    func restart() {
        generation += 1
        request?.endAudio()
        task?.cancel()
        if !lastText.isEmpty {
            emit(["type": "transcript", "source": source, "text": lastText, "isFinal": true])
            lastText = ""
        }
        let current = generation
        let next = SFSpeechAudioBufferRecognitionRequest()
        next.requiresOnDeviceRecognition = true // Never silently fall back to Apple's servers.
        next.shouldReportPartialResults = true
        request = next
        task = recognizer.recognitionTask(with: next) { [weak self] result, error in
            guard let self = self else { return }
            self.queue.async {
                guard current == self.generation else { return }
                if let result = result {
                    self.lastText = result.bestTranscription.formattedString
                    emit(["type": "transcript", "source": self.source, "text": self.lastText, "isFinal": result.isFinal])
                    if result.isFinal { self.lastText = ""; self.restart(); return }
                }
                if let error = error as NSError? {
                    if error.code == 1110 { self.restart() } // No speech in this segment.
                    else { self.onError("Local speech recognition failed: \(error.localizedDescription). Check Dictation language availability or select another speech provider.") }
                }
            }
        }
    }

    func stop() {
        generation += 1
        timer?.cancel()
        request?.endAudio()
        task?.cancel()
        if !lastText.isEmpty { emit(["type": "transcript", "source": source, "text": lastText, "isFinal": true]) }
        lastText = ""
    }
}

@available(macOS 13.0, *)
final class AudioCapture: NSObject, SCStreamOutput, SCStreamDelegate {
    let audioQueue = DispatchQueue(label: "overlay.audio.samples")
    let engine = AVAudioEngine()
    var stream: SCStream?
    var speech: [String: SpeechChannel] = [:]
    var converters: [String: AVAudioConverter] = [:]
    var levelsAt: [String: TimeInterval] = [:]
    var hasTap = false
    var stopping = false
    let local: Bool
    let locale: String
    let mic: Bool
    let system: Bool
    let pcmFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 24000, channels: 1, interleaved: true)!

    init(mic: Bool, system: Bool, local: Bool, locale: String) {
        self.mic = mic; self.system = system; self.local = local; self.locale = locale
    }

    func start() async throws {
        guard mic || system else { throw failure("Enable Microphone or System audio in Settings.") }
        if mic {
            let allowed = await AVCaptureDevice.requestAccess(for: .audio)
            guard allowed else { throw failure("Microphone access denied. Allow InterviewOverlay in System Settings → Privacy & Security → Microphone, then restart the app.") }
        }
        if local {
            let status = await withCheckedContinuation { continuation in
                SFSpeechRecognizer.requestAuthorization { continuation.resume(returning: $0) }
            }
            guard status == .authorized else { throw failure("Speech Recognition access denied. Allow InterviewOverlay in System Settings → Privacy & Security → Speech Recognition.") }
            try audioQueue.sync {
                for source in [mic ? "mic" : nil, system ? "system" : nil].compactMap({ $0 }) {
                    speech[source] = try SpeechChannel(source: source, locale: locale, queue: audioQueue) { message in
                        emit(["type": "error", "message": message])
                    }
                }
            }
        }
        if system {
            let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
            guard let display = content.displays.first else { throw failure("No display available for system audio capture.") }
            let filter = SCContentFilter(display: display, excludingWindows: [])
            let config = SCStreamConfiguration()
            config.width = 2; config.height = 2
            config.minimumFrameInterval = CMTime(value: 1, timescale: 1)
            config.capturesAudio = true
            config.sampleRate = 24000
            config.channelCount = 1
            config.excludesCurrentProcessAudio = true
            let capture = SCStream(filter: filter, configuration: config, delegate: self)
            try capture.addStreamOutput(self, type: .audio, sampleHandlerQueue: audioQueue)
            stream = capture
            try await capture.startCapture()
        }
        if mic {
            let input = engine.inputNode
            let format = input.outputFormat(forBus: 0)
            guard format.sampleRate > 0 && format.channelCount > 0 else { throw failure("No working microphone input device. Select one in macOS Sound settings.") }
            input.installTap(onBus: 0, bufferSize: 2048, format: format) { [weak self] buffer, _ in
                guard let self = self, let copy = AVAudioPCMBuffer(pcmFormat: buffer.format, frameCapacity: buffer.frameLength) else { return }
                copy.frameLength = buffer.frameLength
                let src = UnsafeMutableAudioBufferListPointer(buffer.mutableAudioBufferList)
                let dst = UnsafeMutableAudioBufferListPointer(copy.mutableAudioBufferList)
                for index in 0..<src.count {
                    if let from = src[index].mData, let to = dst[index].mData { memcpy(to, from, Int(src[index].mDataByteSize)) }
                }
                self.audioQueue.async { self.handle(copy, source: "mic") }
            }
            hasTap = true
            engine.prepare()
            try engine.start()
        }
        emit(["type": "ready", "microphone": mic, "system": system, "localSpeech": local])
    }

    func handle(_ buffer: AVAudioPCMBuffer, source: String) {
        guard !stopping else { return }
        speech[source]?.request?.append(buffer)
        if converters[source]?.inputFormat != buffer.format {
            converters[source] = AVAudioConverter(from: buffer.format, to: pcmFormat)
        }
        guard let converter = converters[source],
              let output = AVAudioPCMBuffer(pcmFormat: pcmFormat, frameCapacity: AVAudioFrameCount(Double(buffer.frameLength) * 24000 / buffer.format.sampleRate) + 32) else { return }
        var supplied = false
        var error: NSError?
        converter.convert(to: output, error: &error) { _, status in
            if supplied { status.pointee = .noDataNow; return nil }
            supplied = true; status.pointee = .haveData; return buffer
        }
        guard error == nil, output.frameLength > 0, let samples = output.int16ChannelData?[0] else { return }
        let now = Date.timeIntervalSinceReferenceDate
        if now - (levelsAt[source] ?? 0) > 0.25 {
            levelsAt[source] = now
            var sum = 0.0
            for index in 0..<Int(output.frameLength) { let sample = Double(samples[index]) / 32768; sum += sample * sample }
            emit(["type": "level", "source": source, "level": sqrt(sum / Double(output.frameLength))])
        }
        if !local {
            let data = Data(bytes: samples, count: Int(output.frameLength) * 2)
            emit(["type": "audio", "source": source, "samples": data.base64EncodedString()])
        }
    }

    func stream(_ stream: SCStream, didOutputSampleBuffer sampleBuffer: CMSampleBuffer, of type: SCStreamOutputType) {
        guard type == .audio, sampleBuffer.isValid,
              let description = sampleBuffer.formatDescription else { return }
        let format = AVAudioFormat(cmAudioFormatDescription: description)
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(sampleBuffer.numSamples)) else { return }
        buffer.frameLength = buffer.frameCapacity
        let status = CMSampleBufferCopyPCMDataIntoAudioBufferList(sampleBuffer, at: 0, frameCount: Int32(sampleBuffer.numSamples), into: buffer.mutableAudioBufferList)
        if status == noErr { handle(buffer, source: "system") }
    }

    func stream(_ stream: SCStream, didStopWithError error: Error) {
        emit(["type": "error", "message": "System audio stopped: \(error.localizedDescription). Check Screen & System Audio Recording permission."])
    }

    func stop() async {
        if hasTap { engine.inputNode.removeTap(onBus: 0); hasTap = false }
        engine.stop()
        try? await stream?.stopCapture()
        audioQueue.sync { stopping = true; for channel in speech.values { channel.stop() }; speech.removeAll() }
    }
}

let args = Set(CommandLine.arguments.dropFirst())
if args.contains("--check") {
    // Read-only diagnostics: never request permissions or start a stream here.
    emit(["type": "capabilities", "microphone": true,
          "systemAudio": ProcessInfo.processInfo.isOperatingSystemAtLeast(OperatingSystemVersion(majorVersion: 13, minorVersion: 0, patchVersion: 0)),
          "onDeviceEnglishSpeech": SFSpeechRecognizer(locale: Locale(identifier: "en-US"))?.supportsOnDeviceRecognition ?? false,
          "microphoneAuthorization": AVCaptureDevice.authorizationStatus(for: .audio).rawValue,
          "speechAuthorization": SFSpeechRecognizer.authorizationStatus().rawValue])
    exit(0)
}
guard #available(macOS 13.0, *) else { emit(["type": "error", "message": "Mac audio requires macOS 13 or later."]); exit(1) }
let localeArg = CommandLine.arguments.first(where: { $0.hasPrefix("--locale=") })?.dropFirst(9)
let capture = AudioCapture(mic: args.contains("--mic"), system: args.contains("--system"), local: args.contains("--local-speech"), locale: localeArg.map(String.init) ?? "en-US")
Task {
    do { try await capture.start() }
    catch { emit(["type": "error", "message": error.localizedDescription]); await capture.stop(); exit(1) }
}
// EOF means the parent quit/crashed: never leave a recording helper behind.
DispatchQueue.global().async {
    while let line = readLine() { if line == "stop" { break } }
    Task { await capture.stop(); emit(["type": "stopped"]); exit(0) }
}
RunLoop.main.run()
