# 💡 LEMMA-lite Forecast: No-code Super-lightweight Forecasting for Disease Time-series

Derived from the more customizable [Python version](https://github.com/scc-usc/LEMMA-forecast)

A browser-based [Hubverse](https://hubverse.io/) forecast generator. Everything runs entirely in browser no server/internet connection/installation required. Generate multiple versions of simple prediction models and combine them using simple ensemble or a Random Forest.

Use it online: https://lemma-lite.vercel.app/

## Features

- **Upload** Hubverse target-data CSV  (plus an optional location/population CSV; recommended for better accuracy).
- **Approaches:** Flatline and ARIMA. **Ensembles:** Basic (quantile) and Quantile Random Forest.
- **Multi-target** selection — pick one or more targets when the data has a `target` column.
- **Training window (for Random Forest) & forecast origins** chosen with dual-handle sliders under the plot.
- **Interactive chart** — zoom (mouse wheel / drag), pan (Ctrl + drag), and click any
  point on the line to set the forecast origin.
- **Download** the result as a Hubverse quantile CSV.

## Quick start

1. Open `index.html` in a browser (or from ).
2. Upload your **Hubverse target data CSV**.
3. *(Optional)* upload a **location / population CSV** to normalize counts/rates across locations.
4. Choose the **target(s)**, **approach**, **ensemble**, **weeks ahead**, and **quantiles**.
5. Adjust the **training window (for Random Forest)** and **forecast origin** sliders under the plot.
6. Click **Generate Forecast**, review the plot, then **Download CSV**.

## Input format

**Target data CSV** (one observation per location per week):

| Column | Required | Notes |
| --- | --- | --- |
| `location` | ✓ | Location code/name. |
| `target_end_date` *or* `date` | ✓ | Weekly date of the observation. |
| `observation` *or* `weekly_rate` *or* `value` | ✓ | The observed value. |
| `target` | optional | If present, choose target(s) in the UI; if absent, all data is treated as a single implicit target. |

**Population CSV** *(optional)*: columns `location_name` and `population`. The population data is used to normalize weekly incidence and can improve Random Forest performance.

## Output

A Hubverse quantile forecast with columns: `origin_date`, `horizon`, `location`,
`target` *(only for multi-target runs)*, `output_type` (`quantile`),
`output_type_id` (the quantile level), and `value`.

## Offline use

Download the files this GitHub repository and run `index.html`.





