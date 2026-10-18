export function main(): void {
  console.log("Welcome to AI Project powered by Antigravity and ECC!");
}

if (process.argv[1] && import.meta.url.endsWith(process.argv[1])) {
  main();
}
