/* Runs one simulation off the main thread so big subnets don't freeze the page. */
importScripts('engine.js');

onmessage = (e) => {
  const { id, cfg, scenario } = e.data;
  try {
    postMessage({ id, result: KCni.simulate(cfg, scenario) });
  } catch (err) {
    postMessage({ id, error: err.message });
  }
};
