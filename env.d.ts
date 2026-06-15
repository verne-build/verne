/// <reference types="vite/client" />

declare module "*.vue" {
	import type { DefineComponent } from "vue";
	const component: DefineComponent<object, object, unknown>;
	export default component;
}

declare global {
	interface Window {
		__VERNE__?: {
			invoke(method: string, params?: unknown): Promise<unknown>;
			listen(event: string, handler: (payload: unknown) => void): Promise<() => void> | (() => void);
			convertFileSrc(path: string): string;
			openExternal(url: string): Promise<void>;
			saveDialog(options?: { defaultPath?: string }): Promise<string | null>;
			startDragging(): void;
		};
}
}
