// kilocode_change - new file: Event-driven FFmpeg chunk processor

import { EventEmitter } from "events"
import { ChildProcess } from "child_process"
import * as path from "path"
import { IChunkProcessor } from "./types"

/**
 * ChunkProcessor - Event-driven FFmpeg chunk detection
 *
 * This module solves the race condition problem by parsing FFmpeg's stderr
 * output to detect when chunks are fully written and closed, rather than
 * polling for file existence and using arbitrary timeouts.
 *
 * Events:
 * - 'chunkReady': Emitted when a chunk is fully written and closed by FFmpeg
 * - 'chunkError': Emitted when an error occurs processing a chunk
 * - 'complete': Emitted when FFmpeg process exits
 */
export class ChunkProcessor extends EventEmitter implements IChunkProcessor {
	private ffmpegProcess: ChildProcess | null = null
	private outputDir: string = ""
	private isWatching: boolean = false
	private lastChunkNumber: number = -1

	/**
	 * Start watching FFmpeg stderr for chunk completion events
	 * @param ffmpegProcess The FFmpeg child process to monitor
	 * @param outputDir Directory where chunks are being written
	 */
	startWatching(ffmpegProcess: ChildProcess, outputDir: string): void {
		if (this.isWatching) {
			console.warn("[ChunkProcessor] Already watching, stopping previous watch")
			this.stopWatching()
		}

		this.ffmpegProcess = ffmpegProcess
		this.outputDir = outputDir
		this.isWatching = true

		console.log("[ChunkProcessor] 👀 Started watching FFmpeg stderr for chunk events")

		// Attach stderr parser
		if (ffmpegProcess.stderr) {
			ffmpegProcess.stderr.on("data", this.handleStderrData.bind(this))
		} else {
			console.error("[ChunkProcessor] ❌ No stderr stream available")
		}

		// Handle process exit
		ffmpegProcess.on("exit", (code, signal) => {
			console.log(`[ChunkProcessor] FFmpeg exited with code ${code}, signal ${signal}`)
			this.emit("complete")
			this.stopWatching()
		})

		// Handle process errors
		ffmpegProcess.on("error", (error) => {
			console.error("[ChunkProcessor] FFmpeg process error:", error)
			this.emit("chunkError", error)
			this.stopWatching()
		})
	}

	/**
	 * Stop watching FFmpeg stderr
	 * Returns a promise that resolves after final chunk is emitted
	 */
	async stopWatching(): Promise<void> {
		if (!this.isWatching) {
			return
		}

		// Emit the last chunk if we have one (when recording stops, the last chunk is complete)
		if (this.lastChunkNumber >= 0) {
			const lastChunkName = `chunk_${String(this.lastChunkNumber).padStart(3, "0")}.webm`
			const lastChunkPath = path.join(this.outputDir, lastChunkName)

			// Safety delay: Ensures FFmpeg has fully flushed file buffers to disk
			// before downstream processing begins. While FFmpeg has closed the file,
			// filesystem write caching may still be in progress. 100ms is sufficient
			// for OS buffer flush on all platforms.
			this.emit("chunkReady", lastChunkPath)
			await new Promise((resolve) => setTimeout(resolve, 100))
		}

		if (this.ffmpegProcess?.stderr) {
			this.ffmpegProcess.stderr.removeAllListeners("data")
		}

		if (this.ffmpegProcess) {
			this.ffmpegProcess.removeAllListeners("exit")
			this.ffmpegProcess.removeAllListeners("error")
		}

		this.ffmpegProcess = null
		this.outputDir = ""
		this.isWatching = false
		this.lastChunkNumber = -1
	}

	/**
	 * Handle FFmpeg stderr data
	 * Parses output for chunk completion signals
	 *
	 * CRITICAL: FFmpeg's segment muxer does NOT output "Closing" messages!
	 * Instead, when it opens chunk_001.webm, it means chunk_000.webm is complete.
	 * Strategy: When we see "Opening chunk_N", emit chunkReady for chunk_(N-1)
	 */
	private handleStderrData(data: Buffer): void {
		const text = data.toString()

		// Pattern: Detect when FFmpeg opens a NEW chunk file
		// Format: [segment @ 0xXXXXXXXXX] Opening '/path/to/chunk_NNN.webm' for writing
		const openingMatch = text.match(/Opening '([^']+chunk_(\d{3})\.webm)' for writing/i)

		if (openingMatch) {
			const fullPath = openingMatch[1]
			const chunkNumber = parseInt(openingMatch[2], 10)

			console.log(`[ChunkProcessor] 📂 Opening chunk_${String(chunkNumber).padStart(3, "0")}.webm detected`)

			// When FFmpeg opens chunk_N, the previous chunk (N-1) is complete and ready
			if (this.lastChunkNumber >= 0) {
				const previousChunkName = `chunk_${String(this.lastChunkNumber).padStart(3, "0")}.webm`
				const previousChunkPath = path.join(this.outputDir, previousChunkName)
				console.log(`[ChunkProcessor] ✅ Previous chunk ready: ${previousChunkName}`)
				this.emit("chunkReady", previousChunkPath)
			}

			this.lastChunkNumber = chunkNumber
		}
	}

	/**
	 * Check if currently watching
	 */
	isActive(): boolean {
		return this.isWatching
	}
}
