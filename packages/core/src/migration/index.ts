/**
 * Migration legacy v3.34 → V3 (spec §7.1) :
 * schéma v3.34 reconstitué + importeur backup→quarantaine→vérif/rollback.
 */
export { createSyntheticLegacyDb } from './legacy-schema.js'
export type { SyntheticLegacyOptions, SyntheticLegacySummary } from './legacy-schema.js'
export { importLegacyDb } from './import-legacy.js'
export type { ImportLegacyInput, ImportLegacyReport } from './import-legacy.js'
export { importTranscripts, TRANSCRIPT_EXTRACTION_SYSTEM } from './import-transcripts.js'
export type {
  ImportTranscriptsInput,
  ImportTranscriptsReport,
  ImportTranscriptsMemoria,
  ImportTranscriptsProgress,
  TranscriptUnit,
} from './import-transcripts.js'
export {
  CHATGPT_EXTRACTION_SYSTEM,
  CHATGPT_FORMAT,
  CHATGPT_KEY_PREFIX,
  JsonArraySplitter,
  NotAnArrayError,
  accessErrorMessage,
  chatGptUnit,
  chatGptUnits,
  chatGptUnitsAsync,
  emptyChatGptStats,
  isConversationsFileName,
  parseChatGptConversation,
  prepareChatGptExport,
  readChatGptExport,
} from './chatgpt-export.js'
export type { ChatGptConversation, ChatGptExportRead, ChatGptStats, PreparedExport } from './chatgpt-export.js'
export { extractZipEntries, readZipEntries, unsafeEntryReason, ZipError, DEFAULT_MAX_EXTRACT_BYTES } from './zip-extract.js'
export type { ExtractedEntry, ZipEntry } from './zip-extract.js'
export {
  addWindowToEstimate,
  emptyEstimate,
  estimateExtractionCost,
  estimateInputTokens,
  estimateOutputTokens,
  CHARS_PER_TOKEN,
  EXTRACTION_MAX_OUTPUT_TOKENS,
} from './extraction-estimate.js'
export type { ExtractionCost, ExtractionEstimate } from './extraction-estimate.js'
export {
  parseClaudeCodeTranscript,
  parseCodexRollout,
  parseCodexHistory,
  parseMarkdown,
  parseTranscript,
  detectTranscriptFormat,
} from './transcript-parsers.js'
export type { Turn, TranscriptFormat } from './transcript-parsers.js'
