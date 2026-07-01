import { createPinia } from "pinia";

// Single shared Pinia instance. The main app installs it (main.ts), and the
// DiffCommentBox island (mounted via its own createApp in DiffView) reuses it so
// its send-to-agent menu can read the same workspace store.
export const pinia = createPinia();
