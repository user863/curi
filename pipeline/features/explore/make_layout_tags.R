# Second layout: t-SNE of the student's tag probabilities (PCA 50). Run from the repo root after tags_matrix.py:
#   Rscript pipeline/features/explore/make_layout_tags.R [experiments/train]   -> <dir>/explore/layout_tags.json
suppressMessages({ library(jsonlite); library(Rtsne) })
dir <- commandArgs(trailingOnly = TRUE)[1]; if (is.na(dir)) dir <- "experiments/train"
uid <- fromJSON(file.path(dir, "explore", "tags_order.json"))
con <- file(file.path(dir, "explore", "tags_pca.f32"), "rb")
x <- matrix(readBin(con, "numeric", n = length(uid) * 50, size = 4), nrow = length(uid), byrow = TRUE); close(con)
set.seed(1)
cat(nrow(x), "images, t-SNE...\n")
xy <- Rtsne(x, dims = 2, perplexity = 30, theta = 0.5, pca = FALSE, check_duplicates = FALSE, num_threads = 2, verbose = FALSE)$Y
xy <- sweep(xy, 2, apply(xy, 2, min)); xy <- xy / max(xy)
write_json(lapply(seq_along(uid), function(i) list(u = uid[i], x = round(xy[i, 1], 5), y = round(xy[i, 2], 5))),
           file.path(dir, "explore", "layout_tags.json"), auto_unbox = TRUE)
cat("wrote", file.path(dir, "explore", "layout_tags.json"), "\n")
