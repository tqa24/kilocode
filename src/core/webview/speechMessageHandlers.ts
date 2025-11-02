// kilocode_change - new file: Streaming speech message handlers
import { ClineProvider } from "./ClineProvider"
import { SpeechService, ProgressiveResult } from "../../services/speech/SpeechService"
import { HOT_WORD_PHRASE } from "../../services/speech/speechConstants"

/**
 * Cancel speech recording
 */
export async function handleCancelSpeechRecognition(provider: ClineProvider): Promise<void> {
	const speechService = SpeechService.getInstance(provider.providerSettingsManager)

	try {
		const result = await speechService.cancelRecording()
		if (!result.success) {
			await provider.postMessageToWebview({
				type: "speechError",
				text: result.error || "Failed to cancel recording",
			})
		}

		await provider.postMessageToWebview({
			type: "speechSessionStopped",
			values: {
				sessionId: `speech-${Date.now()}`,
				timestamp: Date.now(),
			},
		})
	} catch (error) {
		await provider.postMessageToWebview({
			type: "speechError",
			text: `Failed to cancel recording: ${error instanceof Error ? error.message : "Unknown error"}`,
		})
	}
}

/**
 * Start streaming speech with real-time transcription
 */
export async function handleStartStreamingSpeech(provider: ClineProvider): Promise<void> {
	const speechService = SpeechService.getInstance(provider.providerSettingsManager)

	try {
		// Set up event listeners
		const progressiveUpdateHandler = (result: ProgressiveResult) => {
			provider.postMessageToWebview({
				type: "speechStreamingProgress",
				text: result.text,
				values: {
					chunkId: result.chunkId,
					isInterim: result.isInterim,
					confidence: result.confidence,
					totalDuration: result.totalDuration,
					sequenceNumber: result.sequenceNumber,
					isProgressive: true,
				},
			})
		}

		const hotWordDetectedHandler = (cleanedText: string) => {
			// Hot word detected - send message with cleaned text and auto-submit
			provider.postMessageToWebview({
				type: "speechHotWordDetected",
				text: cleanedText,
				values: {
					timestamp: Date.now(),
					autoSend: true,
				},
			})
			// Clean up listeners
			speechService.off("progressiveUpdate", progressiveUpdateHandler)
			speechService.off("hotWordDetected", hotWordDetectedHandler)
			speechService.off("streamingComplete", streamingCompleteHandler)
			speechService.off("streamingError", streamingErrorHandler)
		}

		const streamingCompleteHandler = (finalText: string, totalChunks: number) => {
			provider.postMessageToWebview({
				type: "speechStreamingStopped",
				text: finalText,
				values: {
					totalChunks,
					timestamp: Date.now(),
				},
			})
			// Clean up listeners
			speechService.off("progressiveUpdate", progressiveUpdateHandler)
			speechService.off("hotWordDetected", hotWordDetectedHandler)
			speechService.off("streamingComplete", streamingCompleteHandler)
			speechService.off("streamingError", streamingErrorHandler)
		}

		const streamingErrorHandler = (error: string) => {
			provider.postMessageToWebview({
				type: "speechStreamingError",
				text: error,
			})
			// Clean up listeners
			speechService.off("progressiveUpdate", progressiveUpdateHandler)
			speechService.off("hotWordDetected", hotWordDetectedHandler)
			speechService.off("streamingComplete", streamingCompleteHandler)
			speechService.off("streamingError", streamingErrorHandler)
		}

		// Attach listeners
		speechService.on("progressiveUpdate", progressiveUpdateHandler)
		speechService.on("hotWordDetected", hotWordDetectedHandler)
		speechService.on("streamingComplete", streamingCompleteHandler)
		speechService.on("streamingError", streamingErrorHandler)

		// Start streaming with hot word detection enabled
		const result = await speechService.startStreamingRecording({
			chunkDurationSeconds: 3,
			overlapDurationSeconds: 1,
			language: "en",
			hotWordEnabled: true,
			hotWordPhrase: HOT_WORD_PHRASE,
		})

		if (result.success) {
			await provider.postMessageToWebview({
				type: "speechStreamingStarted",
				values: {
					sessionId: `streaming-${Date.now()}`,
					language: "en",
					timestamp: Date.now(),
				},
			})
		} else {
			await provider.postMessageToWebview({
				type: "speechStreamingError",
				text: result.error || "Failed to start streaming",
			})
			// Clean up listeners on failure
			speechService.off("progressiveUpdate", progressiveUpdateHandler)
			speechService.off("hotWordDetected", hotWordDetectedHandler)
			speechService.off("streamingComplete", streamingCompleteHandler)
			speechService.off("streamingError", streamingErrorHandler)
		}
	} catch (error) {
		await provider.postMessageToWebview({
			type: "speechStreamingError",
			text: `Failed to start streaming: ${error instanceof Error ? error.message : "Unknown error"}`,
		})
	}
}

/**
 * Stop streaming speech
 */
export async function handleStopStreamingSpeech(provider: ClineProvider): Promise<void> {
	const speechService = SpeechService.getInstance(provider.providerSettingsManager)

	try {
		const result = await speechService.stopStreamingRecording()

		if (result.success && result.finalText) {
			await provider.postMessageToWebview({
				type: "speechStreamingStopped",
				text: result.finalText,
				values: {
					totalChunks: result.totalChunks || 0,
					timestamp: Date.now(),
				},
			})
		} else {
			await provider.postMessageToWebview({
				type: "speechStreamingError",
				text: result.error || "Failed to stop streaming",
			})
		}
	} catch (error) {
		await provider.postMessageToWebview({
			type: "speechStreamingError",
			text: `Failed to stop streaming: ${error instanceof Error ? error.message : "Unknown error"}`,
		})
	}
}
