const { ping } = require('@homebridge/node-icmp-ping');
(async () => {
  try {
    const results = await Promise.all(process.argv.slice(2).map(ip => ping(ip)));
    console.log(results);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
})();
