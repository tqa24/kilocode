// kilocode_change - new file
/**
 * GitWatcher - Monitors git repository state and emits file events
 *
 * This module provides a lightweight git watcher that:
 * - Emits file events for tracked files in a git repository
 * - Monitors git state changes (commits, branch switches)
 * - Supports delta-based scanning on feature branches
 * - Implements vscode.Disposable for proper cleanup
 */

import * as vscode from "vscode"
import * as path from "path"
import * as fs from "fs"
import { EventEmitter } from "events"
import { execGetLines } from "./utils/exec"
import {
	getCurrentBranch,
	getCurrentCommitSha,
	getGitHeadPath,
	isDetachedHead,
	getBaseBranch,
	getGitDiff,
} from "../services/code-index/managed/git-utils"

/**
 * Configuration for GitWatcher
 */
export interface GitWatcherConfig {
	/**
	 * Working directory (git repository root)
	 */
	cwd: string

	/**
	 * Optional override for the default branch name
	 * If not provided, will be determined automatically
	 */
	defaultBranchOverride?: string
}

/**
 * File event data emitted by GitWatcher
 */
export interface GitFileEvent {
	/**
	 * Relative path to the file from repository root
	 */
	filePath: string

	/**
	 * Git hash of the file (from git ls-files -s)
	 */
	fileHash: string

	/**
	 * Current branch name
	 */
	branch: string
}

/**
 * Git state snapshot for change detection
 */
interface GitStateSnapshot {
	branch: string
	commit: string
	isDetached: boolean
}

/**
 * GitWatcher - Monitors git repository and emits file events
 *
 * Usage:
 * ```typescript
 * const watcher = new GitWatcher({ cwd: '/path/to/repo' })
 * watcher.onFile((event) => {
 *   console.log(`File: ${event.filePath}, Hash: ${event.fileHash}, Branch: ${event.branch}`)
 * })
 * await watcher.scan()
 * ```
 */
export class GitWatcher implements vscode.Disposable {
	private readonly config: GitWatcherConfig
	private readonly emitter: EventEmitter
	private readonly disposables: vscode.Disposable[] = []
	private currentState: GitStateSnapshot | null = null
	private isProcessing = false
	private defaultBranch: string | null = null

	constructor(config: GitWatcherConfig) {
		this.config = config
		this.emitter = new EventEmitter()
	}

	/**
	 * Register a handler for file events
	 * @param handler Callback function that receives file event data
	 */
	public onFile(handler: (data: GitFileEvent) => void): void {
		this.emitter.on("file", handler)
	}

	/**
	 * Scan the repository and emit file events
	 *
	 * Behavior:
	 * - On default/main branch: Emits all tracked files
	 * - On feature branch: Emits only files that differ from default branch
	 */
	public async scan(): Promise<void> {
		try {
			// Check if in detached HEAD state
			if (await isDetachedHead(this.config.cwd)) {
				return
			}

			const currentBranch = await getCurrentBranch(this.config.cwd)
			const defaultBranch = await this.getDefaultBranch()

			// Determine if we're on the default branch
			const isOnDefaultBranch = currentBranch.toLowerCase() === defaultBranch.toLowerCase()

			if (isOnDefaultBranch) {
				// On default branch: emit all tracked files
				await this.scanAllFiles(currentBranch)
			} else {
				// On feature branch: emit only diff files
				await this.scanDiffFiles(currentBranch, defaultBranch)
			}
		} catch (error) {
			console.error("[GitWatcher] Error during scan:", error)
			throw error
		}
	}

	/**
	 * Dispose of the watcher and clean up resources
	 */
	public dispose(): void {
		this.emitter.removeAllListeners()
		for (const disposable of this.disposables) {
			disposable.dispose()
		}
		this.disposables.length = 0
	}

	/**
	 * Start monitoring git state changes
	 * Must be called after construction to begin watching for git changes
	 */
	public async start(): Promise<void> {
		try {
			// Get initial git state
			const isDetached = await isDetachedHead(this.config.cwd)
			if (!isDetached) {
				const [branch, commit] = await Promise.all([
					getCurrentBranch(this.config.cwd),
					getCurrentCommitSha(this.config.cwd),
				])
				this.currentState = { branch, commit, isDetached: false }
			}

			// Set up file system watchers for git state changes
			await this.setupGitWatchers()
		} catch (error) {
			console.error("[GitWatcher] Failed to initialize watcher:", error)
		}
	}

	/**
	 * Set up file system watchers for git state changes
	 */
	private async setupGitWatchers(): Promise<void> {
		try {
			const gitHeadPath = await getGitHeadPath(this.config.cwd)
			const absoluteGitHeadPath = path.isAbsolute(gitHeadPath)
				? gitHeadPath
				: path.join(this.config.cwd, gitHeadPath)

			// Watch .git/HEAD for branch switches and commits
			const headWatcher = vscode.workspace.createFileSystemWatcher(absoluteGitHeadPath)

			this.disposables.push(
				headWatcher.onDidChange(() => {
					this.handleGitChange()
				}),
			)

			this.disposables.push(headWatcher)

			// Watch branch refs for commits
			try {
				const gitDir = path.dirname(absoluteGitHeadPath)
				const refsHeadsPattern = path.join(gitDir, "refs", "heads", "**")
				const refsWatcher = vscode.workspace.createFileSystemWatcher(refsHeadsPattern)

				this.disposables.push(
					refsWatcher.onDidChange(() => {
						this.handleGitChange()
					}),
				)

				this.disposables.push(refsWatcher)
			} catch (error) {
				console.warn("[GitWatcher] Could not watch branch refs:", error)
			}

			// Watch packed-refs
			try {
				const gitDir = path.dirname(absoluteGitHeadPath)
				const packedRefsPath = path.join(gitDir, "packed-refs")

				if (fs.existsSync(packedRefsPath)) {
					const packedRefsWatcher = vscode.workspace.createFileSystemWatcher(packedRefsPath)

					this.disposables.push(
						packedRefsWatcher.onDidChange(() => {
							this.handleGitChange()
						}),
					)

					this.disposables.push(packedRefsWatcher)
				}
			} catch (error) {
				console.warn("[GitWatcher] Could not watch packed-refs:", error)
			}
		} catch (error) {
			console.error("[GitWatcher] Failed to setup git watchers:", error)
		}
	}

	/**
	 * Handle git state changes
	 */
	private async handleGitChange(): Promise<void> {
		if (this.isProcessing) {
			return
		}

		try {
			this.isProcessing = true

			// Check for detached HEAD
			if (await isDetachedHead(this.config.cwd)) {
				this.currentState = null
				return
			}

			// Get new git state
			const [branch, commit] = await Promise.all([
				getCurrentBranch(this.config.cwd),
				getCurrentCommitSha(this.config.cwd),
			])
			const newState: GitStateSnapshot = { branch, commit, isDetached: false }

			// Check if state actually changed
			if (this.currentState) {
				const branchChanged = this.currentState.branch !== newState.branch
				const commitChanged = this.currentState.commit !== newState.commit

				if (!branchChanged && !commitChanged) {
					return
				}

				// Trigger scan on state change
				await this.scan()
			}

			this.currentState = newState
		} catch (error) {
			console.error("[GitWatcher] Error handling git change:", error)
		} finally {
			this.isProcessing = false
		}
	}

	/**
	 * Get the default branch name
	 */
	private async getDefaultBranch(): Promise<string> {
		if (this.defaultBranch) {
			return this.defaultBranch
		}

		if (this.config.defaultBranchOverride) {
			this.defaultBranch = this.config.defaultBranchOverride
			return this.defaultBranch
		}

		this.defaultBranch = await getBaseBranch(this.config.cwd)
		return this.defaultBranch
	}

	/**
	 * Scan all tracked files in the repository
	 */
	private async scanAllFiles(branch: string): Promise<void> {
		try {
			// Use git ls-files -s to get all tracked files with their hashes
			for await (const line of execGetLines({
				cmd: "git ls-files -s",
				cwd: this.config.cwd,
				context: "scanning git tracked files",
			})) {
				const trimmed = line.trim()
				if (!trimmed) continue

				// Parse git ls-files -s output
				// Format: <mode> <hash> <stage> <path>
				// Example: 100644 e69de29bb2d1d6434b8b29ae775ad8c2e48c5391 0 README.md
				const parts = trimmed.split(/\s+/)
				if (parts.length < 4) continue

				const fileHash = parts[1]
				const filePath = parts.slice(3).join(" ") // Handle paths with spaces

				this.emitter.emit("file", {
					filePath,
					fileHash,
					branch,
				})
			}
		} catch (error) {
			console.error("[GitWatcher] Error scanning all files:", error)
			throw error
		}
	}

	/**
	 * Scan only files that differ from the default branch
	 */
	private async scanDiffFiles(currentBranch: string, defaultBranch: string): Promise<void> {
		try {
			// Get the diff between current branch and default branch
			const diff = await getGitDiff(currentBranch, defaultBranch, this.config.cwd)

			// Combine added and modified files (we only care about files that exist)
			const filesToScan = [...diff.added, ...diff.modified]

			// For each file in the diff, get its hash and emit
			for (const filePath of filesToScan) {
				try {
					// Use git ls-files -s to get the hash for this specific file
					const lines: string[] = []
					for await (const line of execGetLines({
						cmd: `git ls-files -s "${filePath}"`,
						cwd: this.config.cwd,
						context: "getting file hash",
					})) {
						lines.push(line)
					}

					if (lines.length === 0) continue

					const trimmed = lines[0].trim()
					const parts = trimmed.split(/\s+/)
					if (parts.length < 4) continue

					const fileHash = parts[1]

					this.emitter.emit("file", {
						filePath,
						fileHash,
						branch: currentBranch,
					})
				} catch (error) {
					console.warn(`[GitWatcher] Could not get hash for file ${filePath}:`, error)
				}
			}
		} catch (error) {
			console.error("[GitWatcher] Error scanning diff files:", error)
			throw error
		}
	}
}
