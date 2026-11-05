// Schedule of Rates Template — Typst
// Renders a paginated rate schedule with section headers and running page totals.

#import "@preview/tablex:0.0.8": tablex

#let data    = json(sys.inputs.at("data_file"))
#let meta    = data.document_meta
#let sections = data.sections   // [{ name, items: [{ code, description, unit, rate }] }]

#set page(
  paper: "a4",
  margin: (top: 20mm, bottom: 25mm, left: 20mm, right: 15mm),
  header: [
    #set text(size: 8pt, fill: luma(100))
    #meta.title · Page #counter(page).display("1 of 1", both: true)
    #line(length: 100%, stroke: 0.5pt)
  ],
)
#set text(font: "Linux Libertine", size: 9pt)

#align(center)[
  #text(weight: "bold", size: 13pt)[SCHEDULE OF RATES]
  #linebreak()
  #text(size: 10pt)[#meta.title · FY #meta.financial_year]
]
#v(6mm)

#for section in sections {
  text(weight: "bold", size: 10pt)[#section.name]
  v(2mm)
  tablex(
    columns: (3em, 1fr, 4em, 7em),
    repeat-header: true,
    fill: (_, row) => if row == 0 { luma(230) } else if calc.odd(row) { luma(248) } else { white },
    align: (col, _) => if col == 3 { right } else { left },
    stroke: 0.5pt,
    [*Code*], [*Description*], [*Unit*], [*Rate (₹)*],
    ..section.items.map(i => (
      [#i.code], [#i.description], [#i.unit], [#i.rate]
    )).flatten()
  )
  v(5mm)
}
