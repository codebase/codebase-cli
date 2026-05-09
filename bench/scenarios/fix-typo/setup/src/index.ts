export function greet(name: string): string {
	return `helo world, ${name}`;
}

if (import.meta.url === `file://${process.argv[1]}`) {
	console.log(greet("everyone"));
}
