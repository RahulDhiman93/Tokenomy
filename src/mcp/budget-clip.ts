import type { QueryResult } from "../graph/types.js";
import { clipResultToBudget } from "../graph/query/budget.js";

export const clipToolResultToBudget = <T>(
  result: QueryResult<T>,
  budgetBytes: number,
): QueryResult<T> => clipResultToBudget(result, budgetBytes);
