export interface AssetEnv {
  readonly ASSETS: {
    fetch(request: Request): Promise<Response>;
  };
}

export function handleAssetRequest(request: Request, env: AssetEnv): Promise<Response> {
  return env.ASSETS.fetch(request);
}

export default { fetch: handleAssetRequest };
