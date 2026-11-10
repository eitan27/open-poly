// The open document's variables, offered as autocomplete wherever an
// expression is typed (ExprInput). Provided once by App — a part's variables,
// or an assembly's — so no dialog needs them passed down.
//
// A .ts file beside ExprInput.tsx rather than inside it: a module that exports
// a component and anything else loses Fast Refresh (see dimAutocomplete.ts).
import { createContext } from "react";
import type { VarOption } from "./DimValueInput";

export const ExprVariables = createContext<VarOption[]>([]);
