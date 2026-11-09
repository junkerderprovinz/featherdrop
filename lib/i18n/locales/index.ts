// One table per language, nested by screen. English is the source every
// other table follows key for key, as test/locales.test.ts checks.
import ar from "./ar.json";
import cs from "./cs.json";
import da from "./da.json";
import de from "./de.json";
import el from "./el.json";
import en from "./en.json";
import es from "./es.json";
import fi from "./fi.json";
import fr from "./fr.json";
import he from "./he.json";
import hu from "./hu.json";
import it from "./it.json";
import ja from "./ja.json";
import ko from "./ko.json";
import nl from "./nl.json";
import no from "./no.json";
import pl from "./pl.json";
import pt from "./pt.json";
import ro from "./ro.json";
import ru from "./ru.json";
import sv from "./sv.json";
import th from "./th.json";
import tr from "./tr.json";
import uk from "./uk.json";
import vi from "./vi.json";
import zh from "./zh.json";

export type Table = { [key: string]: string | Table };

export const tables: Record<string, Table> = {
  ar, cs, da, de, el, en, es, fi, fr, he, hu, it, ja, ko, nl, no, pl, pt, ro, ru, sv, th, tr, uk, vi, zh,
};
