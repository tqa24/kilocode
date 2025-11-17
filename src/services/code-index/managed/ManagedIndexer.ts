/**
 * When extension activates, we need to instantiate the ManagedIndexer and then
 * fetch the api configuration deets and then fetch the organization to see
 * if the feature is enabled for the organization. If it is, then we will
 * instantiate a git-watcher for every folder in the workspace. We will also
 * want to initiate a scan of every folder in the workspace. git-watcher's
 * responsibility is to to alert the ManagedIndexer on branch/commit changes
 * for a given workspace folder. The ManagedIndexer can then run a new scan
 * for that workspace folder. If there is an on-going scan for that particular
 * workspace folder, then we will cancel the on-going scan and start a new one.
 *
 * Scans should be cancellable. The ManagedIndexer should track ongoing scans
 * so that they can be cancelled when the ManagedIndexer is disposed or if the
 * workspace folder is removed, or if the git-watcher detects a change.
 *
 * Git Watchers too can be disposed in the case of the ManagedIndexer being
 * disposed or the workspace folder being removed.
 *
 * Questions:
 *   - How do we communicate state to the webview?
 *   - Should we pass in an instance of ClineProvider or should we pass
 *     ManagedIndexer into ClineProvider?
 *   - How do we populate prompts and provide the tool definitions?
 *   - How do we translate a codebase_search tool call to ManagedIndexer?
 *   - If we're supporting multiple workspace folders, how do we represent
 *     that in the webview UI?
 *
 *
 * The current git watcher implementation is too tied to the managed indexing
 * concept and should be abstracted to be a regular ol' dispoable object that
 * can be instantiated based on a cwd.
 *
 * The scanner implementation should be updated to be able to introspect
 *
 *
 * -----------------------------------------------------------------------------
 *
 * We can think of ManagedIndexer as a few components:
 *
 * 1. Inputs - Workspace Folders and Profile/Organization
 * 2. Derived values - Project Config and Organization/Profile (is feature enabled)
 * 3. Git Watchers
 */

import * as vscode from "vscode"
import type { ClineProvider } from "../../../core/webview/ClineProvider"
import { KiloOrganization } from "../../../shared/kilocode/organization"
import { OrganizationService } from "../../kilocode/OrganizationService"

interface ManagedIndexerConfig {
	kilocodeToken: string | null
	kilocodeOrganizationId: string | null
	kilocodeTesterWarningsDisabledUntil: number | null
}

export class ManagedIndexer implements vscode.Disposable {
	// Handle changes to vscode workspace folder changes
	workspaceFoldersListener = vscode.workspace.onDidChangeWorkspaceFolders(this.onDidChangeWorkspaceFolders)

	// config: ManagedIndexerConfig = {
	// 	kilocodeOrganizationId: null,
	// 	kilocodeToken: null,
	// }

	// organization: KiloOrganization | null = null

	constructor(
		/**
		 * We need to pass through the main ClineProvider for access to global state
		 * and to react to changes in organizations/profiles
		 */
		public provider: ClineProvider,
	) {}

	async fetchConfig(): Promise<ManagedIndexerConfig> {
		const {
			apiConfiguration: {
				kilocodeOrganizationId = null,
				kilocodeToken = null,
				kilocodeTesterWarningsDisabledUntil = null,
			},
		} = await this.provider.getState()

		return { kilocodeOrganizationId, kilocodeToken, kilocodeTesterWarningsDisabledUntil }
	}

	async fetchOrganization(): Promise<KiloOrganization | null> {
		const config = await this.fetchConfig()

		if (config.kilocodeToken && config.kilocodeOrganizationId) {
			return await OrganizationService.fetchOrganization(
				config.kilocodeToken,
				config.kilocodeOrganizationId,
				config.kilocodeTesterWarningsDisabledUntil ?? undefined,
			)
		}

		return null
	}

	dispose() {
		this.workspaceFoldersListener.dispose()
	}

	// onConfigChange(config: ManagedIndexerConfig) {
	// 	if (config.kilocodeToken !== this.config.kilocodeToken) {
	// 		this.config = config
	// 		this.organization = null
	// 	}
	// }

	onDidChangeWorkspaceFolders(e: vscode.WorkspaceFoldersChangeEvent) {
		// Cleanup any watchers and ongoing scans for removed folders
		// Instantiate watchers and start scans for new folders
	}
}
