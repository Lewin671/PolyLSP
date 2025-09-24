export function runDemo(name: string): string {
    return `PolyLSP TypeScript demo says hi to ${name}!`;
}

function main() {
    const message = runDemo('Ada');
    console.log(message);
}

main();