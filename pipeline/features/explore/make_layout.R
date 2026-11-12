# Colour vectors -> 2D layout (t-SNE) for the explorer. Run from the repo root:
#   Rscript pipeline/features/explore/make_layout.R [experiments/train]   -> <dir>/explore/layout.json
# Vector per image (OKLab, a and b stretched so hue counts): weighted mean L a b, weighted spread of L a b,
# the heaviest palette colour, contrast, chroma.
suppressMessages({ library(jsonlite); library(Rtsne) })
dir <- (commandArgs(trailingOnly = TRUE)[1]); if (is.na(dir)) dir <- "experiments/train"
colour <- fromJSON(file.path(dir, "colour.json"), simplifyVector = FALSE)
AB <- 3
vec <- function(f) {
  w <- vapply(f$palette, function(p) p$weight, 0); w <- w / sum(w)
  lab <- t(vapply(f$palette, function(p) unlist(p$lab), numeric(3))) * c(1, AB, AB)
  mu <- colSums(lab * w)
  sd <- sqrt(colSums(w * sweep(lab, 2, mu)^2))
  top <- lab[which.max(w), ]
  c(mu, sd, top, f$contrast, f$chroma * AB)
}
uid <- vapply(names(colour), function(f) sub("\\.jpg$", "", basename(f)), "")
X <- t(vapply(colour, vec, numeric(11)))
X <- scale(X)
set.seed(1)
cat(nrow(X), "images, t-SNE...\n")
xy <- Rtsne(X, dims = 2, perplexity = 30, theta = 0.5, pca = FALSE, check_duplicates = FALSE, num_threads = 2, verbose = FALSE)$Y
xy <- sweep(xy, 2, apply(xy, 2, min)); xy <- xy / max(xy)
write_json(lapply(seq_along(uid), function(i) list(u = uid[i], x = round(xy[i, 1], 5), y = round(xy[i, 2], 5))),
           file.path(dir, "explore", "layout.json"), auto_unbox = TRUE)
cat("wrote", file.path(dir, "explore", "layout.json"), "\n")
