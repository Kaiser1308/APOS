/** The benchmark uses Linux process and filesystem semantics for isolation and measurement. */
export function assertSupportedPlatform(platform = process.platform) {
  if (platform !== 'linux') throw new Error('benchmark requires Linux');
}
