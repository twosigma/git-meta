echo "Setting up 'merge' demo"
{
    rm -rf demo
    mkdir demo
    cd demo
    git init --bare meta-bare
    git clone meta-bare meta
    cd meta
    touch README.md
    git add README.md
    git com -m rm
    git push origin master
    cd ..
    git init --bare x-bare
    git clone x-bare x
    cd x
    touch foo
    git add foo
    git com -m "first x"
    git push origin master
    cd ..
    git init --bare y-bare
    git clone y-bare y
    cd y
    touch bar
    git add bar
    git com -m "first y"
    git push origin master
    cd ..
    git init --bare z-bare
    git clone z-bare z
    cd z
    touch bam
    git add bam
    git com -m "first z"
    git push origin master
    cd ..
    cd meta
    git meta include ../x-bare x
    git meta include ../y-bare y
    git meta commit -m "added subs"
    git meta push
    git meta checkout other
    cd x
    touch baz
    git add baz
    cd ../y
    touch howz
    git add howz
    cd ..
    git meta commit -am "added things"
    git meta push
    cd x
    touch zab
    git add zab
    cd ../y
    touch zwoh
    git add zwoh
    cd ..
    git meta commit -am "added other things"
    git meta push
    git meta include ../z-bare z
    git meta commit -am "added z"
    git meta push
    git meta checkout master
    cd x
    echo asdfas >> foo
    cd ../y
    echo aaaaaaaa >> bar
    cd ..
    git meta commit -am "changed things"
    git meta push
    git meta close x
} &> /dev/null
