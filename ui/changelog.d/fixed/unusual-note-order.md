- **"Worth a second look" names someone who left a payroll by the name the previous payroll gave
  them, and lists what matters first (#950).** In 0.21.0 a person dropped from a payroll could be
  named by a label from an older payroll, and the note listed its lines in the order the comparison
  produced them, so an amount above usual could end up counted in "and N more". An amount above
  usual and a person dropped from the payroll now come first, then an address with no earlier
  payment, and a changed amount last, so in a round of raises an address never paid before is still
  shown.
