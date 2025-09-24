export function runDemo(name: string): string {
    return `PolyLSP TypeScript demo says hi to ${name}!`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const message = runDemo('Ada');
    console.log(message);
}


