# Image explorer: every training picture placed by its colour vector; thumbnails stand in for points and open on click.
#   Rscript -e 'shiny::runApp("pipeline/features/explore", port = 4430)'   (after make_layout.R and build_train_report.py)
library(shiny)
library(jsonlite)

train <- normalizePath(Sys.getenv("TRAIN_DIR", "../../../experiments/train"))
addResourcePath("train", train)
items <- fromJSON(file.path(train, "report", "data.json"), simplifyVector = TRUE)
sources <- sort(unique(items$src))
hues <- sort(unique(na.omit(items$hue)))

ui <- fluidPage(
  tags$head(tags$title("Colour explorer"), tags$link(rel = "stylesheet", href = "explore.css"), tags$script(src = "explore.js", defer = NA)),
  div(id = "bar",
    textInput("q", NULL, placeholder = "search title, creator, tags", width = "260px"),
    selectInput("src", NULL, c("all sources" = "", sources), width = "150px"),
    selectInput("hue", NULL, c("all hues" = "", hues), width = "120px"),
    selectInput("layout", NULL, c("layout: colour" = "colour", "layout: student tags" = "tags"), width = "190px"),
    selectInput("mono", NULL, c("colour + mono" = "", "monochrome" = "1", "not mono" = "0"), width = "140px"),
    checkboxInput("labelled", "labelled only", FALSE, width = "130px"),
    span(id = "count")),
  tags$canvas(id = "cv"),
  div(id = "tip"),
  div(id = "open", hidden = NA)
)

server <- function(input, output, session) {
  q <- debounce(reactive(input$q), 250)
  observe(session$sendCustomMessage("filter", list(q = q(), src = input$src, hue = input$hue, mono = input$mono, layout = input$layout, labelled = isTRUE(input$labelled))))
}

shinyApp(ui, server)
