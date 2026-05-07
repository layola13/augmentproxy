function expandSimpleMkdirBraceCommand(command) {
  const mkdirPattern = /\bmkdir\s+-p\b/g;
  let output = "";
  let lastIndex = 0;
  let match;
  let iterations = 0;

  while ((match = mkdirPattern.exec(command))) {
    iterations++;
    if (iterations > 100) {
        console.log("INFINITE LOOP DETECTED");
        process.exit(1);
    }
    const segmentStart = match.index;
    const argsStart = mkdirPattern.lastIndex;
    const tail = command.slice(argsStart);
    const separatorMatch = /&&|\|\||[;|\n]/.exec(tail);
    const separatorIndex = separatorMatch
      ? argsStart + separatorMatch.index
      : command.length;
    
    console.log(`Match: ${match[0]}, index: ${match.index}, lastIndex: ${mkdirPattern.lastIndex}, separatorIndex: ${separatorIndex}`);

    lastIndex = separatorIndex;
    mkdirPattern.lastIndex = separatorIndex;
  }

  if (lastIndex === 0) return command;
  return `${output}${command.slice(lastIndex)}`;
}

console.log("Testing mkdir -p;");
expandSimpleMkdirBraceCommand("mkdir -p; ls");
