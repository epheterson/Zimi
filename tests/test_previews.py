

def test_inline_text_drops_script_and_style_in_any_case():
    from zimi.previews import inline_text

    assert inline_text("a<SCRIPT>\nx()\n</SCRIPT>b<Style type='x'>p{}</STYLE>c") == "abc"


def test_a_qid_index_path_stays_in_the_index_folder():
    import pytest

    from zimi import interlang

    with pytest.raises(ValueError):
        interlang._qid_index_path("../../etc/passwd")
    assert interlang._qid_index_path("wikipedia_en").startswith(interlang._qid_index_dir())
