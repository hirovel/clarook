//
// This is only a SKELETON file for the 'Transpose' exercise. It's been provided as a
// convenience to get you started writing code faster.
//

export const transpose = (input) => {
  const lines = input.map((line) => String(line));
  const maxLength = lines.reduce((max, line) => Math.max(max, line.length), 0);

  const rows = [];
  for (let column = 0; column < maxLength; column++) {
    // Read one column, marking missing characters (padding) as null so that
    // they can be told apart from real spaces in the input.
    const cells = lines.map((line) =>
      column < line.length ? line[column] : null,
    );

    // Drop padding to the right only; keep real spaces.
    let last = cells.length - 1;
    while (last >= 0 && cells[last] === null) {
      last--;
    }

    rows.push(
      cells
        .slice(0, last + 1)
        .map((cell) => (cell === null ? ' ' : cell))
        .join(''),
    );
  }

  return rows;
};
