//
// This is only a SKELETON file for the 'Phone Number' exercise. It's been provided as a
// convenience to get you started writing code faster.
//

export const clean = (number) => {
  if (/[a-zA-Z]/.test(number)) {
    throw new Error('Letters not permitted');
  }

  const digits = number.replace(/[()+\-.\s]/g, '');
  if (/\D/.test(digits)) {
    throw new Error('Punctuations not permitted');
  }

  if (digits.length > 11) {
    throw new Error('More than 11 digits');
  }
  if (digits.length < 10) {
    throw new Error('Incorrect number of digits');
  }
  if (digits.length === 11) {
    if (digits[0] !== '1') {
      throw new Error('11 digits must start with 1');
    }
    return clean(digits.slice(1));
  }

  if (digits[0] === '0') {
    throw new Error('Area code cannot start with zero');
  }
  if (digits[0] === '1') {
    throw new Error('Area code cannot start with one');
  }
  if (digits[3] === '0') {
    throw new Error('Exchange code cannot start with zero');
  }
  if (digits[3] === '1') {
    throw new Error('Exchange code cannot start with one');
  }

  return digits;
};
