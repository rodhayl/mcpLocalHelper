// Test file for edit operations
// Multiple file edit test - Updated!
function hello(name: string, greeting = 'Hello'): string {
  return `${greeting}, ${name}!`;
}

function goodbye(name: string): string {
  return `Goodbye, ${name}!`;
}

function greet(name: string): string {
  return `Greetings, ${name}!`;
}

export { hello, goodbye, greet };
