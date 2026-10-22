module.exports = async () => {
  await Promise.all((globalThis.__containers ?? []).map((container) => container.stop()));
};
