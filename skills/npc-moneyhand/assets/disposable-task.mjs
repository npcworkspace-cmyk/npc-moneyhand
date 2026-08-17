export async function run({ moneyhand, signal, args }) {
  const terminal = await moneyhand.request({
    method: "target.list",
    params: {},
  }, { signal });

  return {
    args,
    terminal,
  };
}
