import moment from "moment-timezone";

// Thresholds mirror the reference achievementService. Evaluate current records
// on each read so obsolete persisted badge rows cannot keep deleted awards alive.
export function liveAchievementMilestones(profile: any, stats: any[], days: Map<string, any>, today: string) {
  const awards = new Map<string, string>();
  const award = (type: string, date: string) => { if (!awards.has(type)) awards.set(type, date); };
  const dates = [...days.keys()].sort();
  const active = dates.filter(date => {
    const row = days.get(date);
    return row.meal_count > 0 || Number(row.water_consumed_ml) > 0 || row.weight_logged_at;
  });
  active.forEach((date, i) => {
    for (const threshold of [3, 7, 14, 30]) if (i + 1 >= threshold) award(`streak_${threshold}`, date);
    const prior = active[i - 1];
    if (prior && moment.utc(date).diff(moment.utc(prior), "days") >= 3) award("comeback", date);
  });
  const history = stats.filter(row => row.weight_kg != null)
    .map(row => ({ date: moment.utc(row.date).format("YYYY-MM-DD"), weight: Number(row.weight_kg), logged: Boolean(row.weight_logged_at) }))
    .filter(row => row.date <= today && Number.isFinite(row.weight) && row.weight > 0)
    .sort((a, b) => a.date.localeCompare(b.date));
  // Retain the first baseline, then only explicit updates, not daily carry-forward weights.
  const weights = history.filter((row, i) => i === 0 || row.logged);
  const baseline = Number(profile.initial_weight_kg);
  const initial = baseline > 0 && Number.isFinite(baseline) ? baseline : weights[0]?.weight;
  const goal = Number(profile.goal_weight_kg);
  const direction = profile.goal_type;
  weights.forEach((row, i) => {
    if (direction === "loss") {
      if (initial - row.weight >= 1) award("first_1kg_lost", row.date);
      if ((initial - row.weight) / initial >= .05) award("five_percent_lost", row.date);
      if (goal > 0 && initial > goal && initial - row.weight >= (initial - goal) / 2) award("halfway_to_goal", row.date);
      if (goal > 0 && row.weight <= goal) award("target_weight_reached_loss", row.date);
    }
    if (direction === "gain") {
      if (row.weight - initial >= 1) award("first_1kg_gained", row.date);
      if (goal > 0 && row.weight >= goal) award("target_weight_reached_gain", row.date);
      const weekly = [row];
      for (let j = i - 1; j >= 0 && weekly.length < 3; j--) {
        if (moment.utc(weekly[weekly.length - 1].date).diff(moment.utc(weights[j].date), "days") >= 5) weekly.push(weights[j]);
      }
      if (weekly.length === 3 && weekly[0].weight > weekly[1].weight && weekly[1].weight > weekly[2].weight) award("consistent_gain_3_weeks", row.date);
    }
  });
  if (direction === "loss" && goal > 0) {
    const hit = weights.findIndex(row => row.weight <= goal);
    if (hit >= 0 && moment.utc(today).diff(moment.utc(weights[hit].date), "days") >= 14
      && weights.slice(hit).every(row => Math.abs(row.weight - goal) <= 1)) {
      award("maintenance_2_weeks", moment.utc(weights[hit].date).add(14, "days").format("YYYY-MM-DD"));
    }
  }
  return { awards, activeDays: active.length };
}
