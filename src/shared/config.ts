/** Reads a required environment variable at cold start. Fails fast so a misconfigured function never serves. */
export const requireEnv = (name: string, env: NodeJS.ProcessEnv = process.env): string => {
  const value = env[name];
  if (value === undefined || value === "") {
    throw new Error(`Missing required environment variable ${name}`);
  }
  return value;
};
