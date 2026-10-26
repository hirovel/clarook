//
// This is only a SKELETON file for the 'Grade School' exercise. It's been provided as a
// convenience to get you started writing code faster.
//

export class GradeSchool {
  constructor() {
    this.students = new Map();
  }

  roster() {
    const result = {};
    for (const [name, grade] of this.students) {
      if (!result[grade]) {
        result[grade] = [];
      }
      result[grade].push(name);
    }
    for (const grade of Object.keys(result)) {
      result[grade].sort();
    }
    return result;
  }

  add(name, grade) {
    this.students.set(name, grade);
  }

  grade(grade) {
    return (this.roster()[grade] || []).slice();
  }
}
