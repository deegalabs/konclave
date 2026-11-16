- **An amount under the bar was still in the page, and a screen reader read it aloud.** The bar
  hid a figure from the eye only: the value stayed in the page as text, so a screen reader read it
  out (and offered "Reveal" after it), and selecting and copying the area around it, or anything
  that reads the page's text, returned it. While amounts are hidden, a hidden figure is no longer
  in the page at all: a placeholder of about its width stands in, a screen reader hears "amount hidden"
  and then the control, and the value arrives only when it is revealed. The Dashboard had three more ways in, closed with it: the balance
  composition's accessible label, the monthly spend chart (each bar's title and the table behind it)
  and the dollar estimate of what was paid. While hidden, the label carries no figures, the chart is
  replaced by a sentence, and the estimate sits under the bar; the "free" and "confirming" lines under
  the balance too. The control also keeps one name ("Reveal amounts") with its state in
  `aria-pressed`, and says "amount hidden" before it. Still not covered: the fee, the total and the
  remainder on a proposal's page, and the balance sentences that block a payment or a payroll on the
  forms, which show in the clear on screen today.
